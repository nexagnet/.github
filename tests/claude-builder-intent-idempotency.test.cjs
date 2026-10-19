'use strict';
// R3 #33: strict owner intent + at-most-one Builder Draft PR per Issue.
// Every case executes the real inline shell from claude-builder.yml against a fake GitHub.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const h = require('./support/builder-harness.cjs');

const gate = h.jobs.preflight.steps.find((s) => s.id === 'gate').run;
const premint = h.stepByName('publish', 'Re-check no competing Builder PR').run;
const draft = h.jobs.publish.steps.find((s) => s.id === 'draft').run;
const tiebreak = h.stepByName('publish', 'Resolve publish race').run;
const BRANCH = (issueNo, run = 7001, attempt = 1) => `claude/issue-${issueNo}-${run}-${attempt}`;

function preflightOutcome(opts, extraEnv = {}) {
  const world = h.makeWorld(opts);
  try {
    const result = h.runScript(world, gate, extraEnv);
    return { ...result, calls: readFileSync(join(world.dir, 'calls.log'), 'utf8') };
  } finally {
    world.cleanup();
  }
}
const accepted = (opts, env) => preflightOutcome(opts, env).ok;

// Convenience: an owner "earlier command" ledger (one page).
const ledger = (...ids) => ids.map((id) => h.comment(id, '@claude'));

test('preflight no longer uses substring matching and requires a standalone command', () => {
  assert.doesNotMatch(gate, /contains\("@claude"\)/);
  assert.match(gate, /INTENT_REJECTED/);
  assert.match(gate, /GITHUB_RUN_ATTEMPT/);
});

test('trigger TRUE: a standalone owner command (trailing whitespace tolerated)', () => {
  for (const body of ['@claude', '@claude\n', '@claude  \r\n', '@claude \t']) {
    const r = preflightOutcome({ ev: h.event({ body }) });
    assert.equal(r.ok, true, JSON.stringify(body) + r.stderr);
    assert.equal(r.outputs.command, 'run');
    assert.equal(r.outputs.attempt, '1');
    assert.equal(r.outputs.comment_id, '5000');
  }
});

test('trigger FALSE: reports, prose, code spans, fences, quotes, multi-line and look-alikes', () => {
  const rejected = [
    'E2E report: Builder run 39207689254 ok. Mention of @claude here is prose.',
    'please @claude do it', 'See `@claude` in the docs', '```\n@claude\n```', '> @claude',
    '> quoted\n\n@claude', '@claude\nand more text', 'Report\n@claude', '@claude retry now',
    '@Claude', '@CLAUDE', ' @claude', '@claude,', '@claudette', 'x@claude', '@claude-bot',
    '@claude retry\n@claude', '', '   ', '- @claude', '**@claude**',
    'https://github.com/nexagnet/legal-office/pull/166 @claude',
  ];
  for (const body of rejected) {
    const r = preflightOutcome({ ev: h.event({ body }) });
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.match(r.stderr, /INTENT_REJECTED/, JSON.stringify(body));
    assert.doesNotMatch(r.calls, /pulls/, 'no PR lookup for a non-command: ' + JSON.stringify(body));
  }
});

test('actor, event and repository gates', () => {
  assert.equal(accepted({ ev: h.event() }), true);
  assert.equal(accepted({ ev: h.event({ login: 'untrusted-user' }), actor: 'untrusted-user' }), false);
  assert.equal(accepted({ ev: h.event(), actor: 'untrusted-user' }), false);
  assert.equal(accepted({ ev: h.event({ type: 'Bot' }) }), false, 'bot-authored comment');
  assert.equal(accepted({ ev: h.event({ sender: 'someone-else' }) }), false);
  assert.equal(accepted({ ev: h.event({ pr: true }) }), false, 'PR thread');
  assert.equal(accepted({ ev: h.event({ action: 'edited' }) }), false);
  assert.equal(accepted({ ev: h.event({ number: 99 }) }), false, 'event issue differs from input');
  assert.equal(accepted({ ev: h.event(), repo: 'nexagnet/.github' }), false);
  assert.equal(accepted({ ev: h.event() }, { GITHUB_EVENT_NAME: 'workflow_dispatch' }), false);
});

test('Task Contract / risk / readiness gates still fail closed', () => {
  const ev = h.event();
  assert.equal(accepted({ ev, iss: h.issue({ state: 'closed' }) }), false);
  assert.equal(accepted({ ev, iss: h.issue({ labels: [{ name: 'risk:R1' }] }) }), false);
  assert.equal(accepted({ ev, iss: h.issue({ labels: [{ name: 'risk:R3' }, { name: 'autopilot:ready' }] }) }), false);
  assert.equal(accepted({ ev, iss: h.issue({ labels: [{ name: 'risk:R1' }, { name: 'risk:R2' }, { name: 'autopilot:ready' }] }) }), false);
  assert.equal(accepted({ ev, iss: h.issue({ labels: [{ name: 'autopilot:ready' }] }) }), false);
  assert.equal(accepted({ ev, iss: h.issue({ body: '## OBJECTIVE' }) }), false);
  for (const risk of ['risk:R0', 'risk:R1', 'risk:R2']) {
    assert.equal(accepted({ ev, iss: h.issue({ labels: [{ name: risk }, { name: 'autopilot:ready' }] }) }), true, risk);
  }
});

test('live comment re-fetch rejects edited, spoofed or moved comments and fails closed on API error', () => {
  const ev = h.event();
  assert.equal(accepted({ ev, liveComment: h.live(ev, { body: '@claude edited' }) }), false);
  assert.equal(accepted({ ev, liveComment: h.live(ev, { id: 4999 }) }), false);
  assert.equal(accepted({ ev, liveComment: h.live(ev, { user: { login: 'other', type: 'User' } }) }), false);
  assert.equal(accepted({ ev, liveComment: h.live(ev, { issue_url: 'https://api.github.com/repos/nexagnet/example/issues/13' }) }), false);
  assert.equal(preflightOutcome({ ev }, { FAKE_GH_FAIL: 'live' }).ok, false);
});

test('human-author check holds at each layer independently (event payload and live comment)', () => {
  const asBot = { login: h.OWNER, type: 'Bot' };
  const asUser = { login: h.OWNER, type: 'User' };
  const evBot = h.event({ type: 'Bot' });
  const evUser = h.event();
  assert.equal(accepted({ ev: evBot, liveComment: h.live(evUser) }), false, 'event says Bot, live says User');
  assert.equal(accepted({ ev: evUser, liveComment: h.live(evUser, { user: asBot }) }), false, 'event says User, live says Bot');
  assert.equal(accepted({ ev: evUser, liveComment: h.live(evUser, { user: asUser }) }), true);
});

test('duplicate command: a second plain @claude is rejected even with no PR (ledger, not timing)', () => {
  const r = preflightOutcome({ ev: h.event({ id: 5100 }), comments: [ledger(5000)] });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /DUPLICATE_COMMAND_REJECTED/);
  // The FIRST of two near-simultaneous commands is still accepted by its own preflight.
  assert.equal(accepted({ ev: h.event({ id: 5000 }), comments: [[h.comment(5000, '@claude'), h.comment(5100, '@claude')]] }), true);
});

test('ledger ignores prose, other users, bots and later comments; counts across pages', () => {
  const noise = [
    h.comment(10, 'Report mentions @claude in prose'), h.comment(11, '`@claude`'),
    h.comment(12, '@claude', 'someone-else'), h.comment(13, '@claude', 'github-actions[bot]', 'Bot'),
    h.comment(9999, '@claude'),
  ];
  assert.equal(accepted({ ev: h.event({ id: 5000 }), comments: [noise] }), true);
  // 100 prose comments on page 1, the owner's earlier command only on page 2.
  const page1 = Array.from({ length: 100 }, (_, i) => h.comment(100 + i, 'status update ' + i));
  const r = preflightOutcome({ ev: h.event({ id: 5000 }), comments: [page1, [h.comment(300, '@claude')]] });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /DUPLICATE_COMMAND_REJECTED/);
  assert.match(r.calls, /--paginate .*issues\/12\/comments/);
});

test('plain @claude is rejected when Builder PR history exists (any state); retry is the only path', () => {
  const r = preflightOutcome({ ev: h.event(), pulls: [[h.pull(167, BRANCH(12), 'closed')]] });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /EXISTING_PR_REJECTED/);
});

test('sanctioned retry: needs an earlier command, no open/merged PR, and a bounded budget of 3 attempts', () => {
  const retry = (id, comments, pulls = [[]]) => preflightOutcome({ ev: h.event({ body: '@claude retry', id }), comments, pulls });
  const none = retry(5100, [[]]);
  assert.equal(none.ok, false, 'retry without any earlier command');
  assert.match(none.stderr, /RETRY_WITHOUT_ATTEMPT/);
  // After BLOCKED / NO_PATCH there is no PR at all: retry allowed, attempt 2.
  const second = retry(5100, [ledger(5000)]);
  assert.equal(second.ok, true, second.stderr);
  assert.equal(second.outputs.command, 'retry');
  assert.equal(second.outputs.attempt, '2');
  // After an explicitly closed/discarded synthetic PR: retry allowed, attempt 3.
  const third = retry(5200, [ledger(5000, 5100)], [[h.pull(167, BRANCH(12), 'closed')]]);
  assert.equal(third.ok, true, third.stderr);
  assert.equal(third.outputs.attempt, '3');
  // Budget exhausted: 4th command.
  const fourth = retry(5300, [ledger(5000, 5100, 5200)]);
  assert.equal(fourth.ok, false);
  assert.match(fourth.stderr, /RETRY_BUDGET_EXHAUSTED/);
  // A rejected duplicate still consumes budget (bounded and auditable by comments).
  assert.equal(retry(5300, [[h.comment(5000, '@claude'), h.comment(5100, '@claude'), h.comment(5200, '@claude retry')]]).ok, false);
});

test('retry is blocked while a Builder Draft is open, including after Repair pushed a new HEAD', () => {
  const open = h.pull(166, BRANCH(12), 'open');
  const ev = h.event({ body: '@claude retry', id: 5100 });
  const r = preflightOutcome({ ev, comments: [ledger(5000)], pulls: [[open]] });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /OPEN_PR_REJECTED/);
  // Repair pushes to the SAME branch/PR: it stays open with a new head SHA; lookup is SHA-independent.
  const repaired = { ...open, head: { ...open.head, sha: 'b'.repeat(40) } };
  assert.equal(preflightOutcome({ ev, comments: [ledger(5000)], pulls: [[repaired]] }).ok, false);
});

test('retry is blocked once a Builder PR was merged', () => {
  const merged = h.pull(166, BRANCH(12), 'closed', { merged: true });
  const r = preflightOutcome({ ev: h.event({ body: '@claude retry', id: 5100 }), comments: [ledger(5000)], pulls: [[merged]] });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /MERGED_PR_REJECTED/);
});

test('PR lookup is paginated: a matching open PR on page 3 is found (a default 30-item list would miss it)', () => {
  const filler = (start) => Array.from({ length: 100 }, (_, i) => h.pull(start + i, `feature/x-${start + i}`, 'closed'));
  const pulls = [filler(1000), filler(2000), [h.pull(166, BRANCH(12), 'open')]];
  const r = preflightOutcome({ ev: h.event({ body: '@claude retry', id: 5100 }), comments: [ledger(5000)], pulls });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /OPEN_PR_REJECTED/);
  assert.match(r.calls, /--paginate repos\/nexagnet\/example\/pulls\?state=all&per_page=100/);
});

test('namespace matching is exact: other issues, forks, deleted forks and unrelated branches never block', () => {
  const ev = h.event({ body: '@claude retry', id: 5100 });
  const noise = [
    h.pull(1, 'claude/issue-120-9-1', 'open'), h.pull(2, 'claude/issue-1-9-1', 'open'),
    h.pull(3, 'claude/issue-12-notnumeric', 'open'), h.pull(4, 'claude/issue-12', 'open'),
    h.pull(5, BRANCH(12), 'open', { repo: 'attacker/example' }), h.pull(6, BRANCH(12), 'open', { repo: null }),
    h.pull(7, 'feature/claude/issue-12-1-1', 'open'),
  ];
  const r = preflightOutcome({ ev, comments: [ledger(5000)], pulls: [noise] });
  assert.equal(r.ok, true, r.stderr);
  // ...but a same-repo PR in the namespace blocks, whatever its author.
  assert.equal(preflightOutcome({ ev, comments: [ledger(5000)], pulls: [[...noise, h.pull(8, BRANCH(12, 1, 2), 'open')]] }).ok, false);
});

test('fail closed on 403 / rate limit / garbage from PR or comment listings', () => {
  for (const fail of ['pulls', 'pulls-garbage', 'comments']) {
    const r = preflightOutcome({ ev: h.event() }, { FAKE_GH_FAIL: fail });
    assert.equal(r.ok, false, fail);
    assert.match(r.stderr, /LOOKUP_FAILED/, fail);
  }
});

test('replay: a GitHub re-run of the same event is rejected', () => {
  const r = preflightOutcome({ ev: h.event() }, { GITHUB_RUN_ATTEMPT: '2' });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /REPLAY_REJECTED/);
});

test('stale HEAD / frozen Task Contract guards are unchanged and the freeze is exported', () => {
  const validator = h.stepByName('publish', 'Validate patch').run;
  assert.match(validator, /Base HEAD changed/);
  assert.match(validator, /Task Contract changed; rerun preflight/);
  assert.match(validator, /Issue readiness revoked/);
  const r = preflightOutcome({ ev: h.event() });
  assert.match(r.outputs.base_sha, /^[0-9a-f]{40}$/);
  assert.match(r.outputs.contract_hash, /^[0-9a-f]{64}$/);
});

test('publisher guard runs before the write token and again right before the first push', () => {
  const steps = h.jobs.publish.steps;
  const idx = (pred) => steps.findIndex(pred);
  const validateIdx = idx((s) => s.name?.startsWith('Validate patch'));
  const premintIdx = idx((s) => s.name?.startsWith('Re-check no competing'));
  const mintIdx = idx((s) => s.id === 'publisher');
  const draftIdx = idx((s) => s.id === 'draft');
  const tieIdx = idx((s) => s.name?.startsWith('Resolve publish race'));
  assert.ok(validateIdx < premintIdx && premintIdx < mintIdx && mintIdx < draftIdx && draftIdx < tieIdx);
  assert.ok(draft.indexOf('\nbot_pr_guard\n') < draft.indexOf('git push'));
  assert.ok(draft.indexOf('DUPLICATE_PR_REJECTED') < draft.indexOf('git push'));
  assert.equal(steps[premintIdx].env.GH_TOKEN, '${{ github.token }}', 'pre-mint check uses the read-only token');
  assert.equal(h.jobs.publish.permissions['pull-requests'], 'read');
  assert.equal(h.jobs.preflight.permissions['pull-requests'], 'read');
});

test('the PR guard is byte-identical in preflight and all publisher steps', () => {
  const reference = h.extractFunction(gate, 'bot_pr_guard');
  assert.ok(reference && reference.includes('--paginate'));
  for (const [name, script] of [['premint', premint], ['draft', draft], ['tiebreak', tiebreak]]) {
    assert.equal(h.extractFunction(script, 'bot_pr_guard'), reference, name);
  }
});

function publisherRun(pulls, env = {}) {
  const world = h.makeWorld({ pulls });
  try { return h.runScript(world, premint, env); } finally { world.cleanup(); }
}

test('publisher pre-mint guard executes: open/merged blocks, closed/none allows, errors fail closed', () => {
  assert.equal(publisherRun([[]]).ok, true);
  assert.equal(publisherRun([[h.pull(167, BRANCH(12), 'closed')]]).ok, true);
  assert.equal(publisherRun([[h.pull(166, BRANCH(12), 'open')]]).ok, false);
  assert.equal(publisherRun([[h.pull(166, BRANCH(12), 'closed', { merged: true })]]).ok, false);
  assert.equal(publisherRun([[h.pull(166, BRANCH(13), 'open')]]).ok, true, 'other issue');
  const filler = Array.from({ length: 100 }, (_, i) => h.pull(1000 + i, `x-${i}`, 'closed'));
  assert.equal(publisherRun([filler, [h.pull(166, BRANCH(12), 'open')]]).ok, false, 'pagination');
  assert.equal(publisherRun([[]], { FAKE_GH_FAIL: 'pulls' }).ok, false);
  assert.equal(publisherRun([[]], { FAKE_GH_FAIL: 'pulls-garbage' }).ok, false);
});

test('concurrency: one workflow-level group per repository+Issue, no job-level reuse, no cancellation', () => {
  const c = h.workflow.concurrency;
  assert.equal(c.group, 'nexagnet-builder-${{ github.repository }}-issue-${{ inputs.issue_number }}');
  assert.equal(c['cancel-in-progress'], false);
  for (const [name, job] of Object.entries(h.jobs)) assert.equal(job.concurrency, undefined, name + ' must not redeclare a group (self-deadlock)');
  assert.equal((h.source.match(/^\s*concurrency:/gm) || []).length, 1);
});

// Several publishers pass every check before any PR exists (the worst-case ordering the
// ledger and serialization are meant to prevent). The tie-break must leave exactly one.
async function raceOf(n) {
  const world = h.makeWorld({ dynamicPulls: [] });
  try {
    h.writeFileSync(join(world.dir, 'premint.sh'), premint);
    h.writeFileSync(join(world.dir, 'tiebreak.sh'), tiebreak);
    const flows = [];
    for (let i = 0; i < n; i++) {
      const flow = join(world.dir, `flow-${i}.sh`);
      h.writeFileSync(flow, [
        'set -euo pipefail',
        `bash "${join(world.dir, 'premint.sh')}"`,
        'created="$(gh api -X POST "repos/$GITHUB_REPOSITORY/pulls" -f title=t -f head="$BRANCH" -f base=main -F draft=true -f body=b)"',
        'export PR_NUMBER="$(jq -r .number <<< "$created")"',
        `bash "${join(world.dir, 'tiebreak.sh')}"`,
      ].join('\n'));
      flows.push(h.spawnScript(world, flow, { FLOW_ID: String(i), BARRIER_N: String(n), BRANCH: BRANCH(12, 9000 + i) }));
    }
    const results = await Promise.all(flows);
    const state = JSON.parse(readFileSync(join(world.dir, 'pulls-state.json'), 'utf8'));
    const deletedLog = join(world.dir, 'deleted-refs.log');
    const deleted = existsSync(deletedLog) ? readFileSync(deletedLog, 'utf8').trim().split('\n') : [];
    return { results, state, deleted };
  } finally {
    world.cleanup();
  }
}

test('concurrent publishers: exactly one open Draft survives (lowest PR number), losers close only themselves', async () => {
  for (const n of [2, 4]) {
    const { results, state, deleted } = await raceOf(n);
    const open = state.prs.filter((p) => p.state === 'open');
    assert.equal(state.prs.length, n, 'every racer created a PR (all checks passed together)');
    assert.equal(open.length, 1, `n=${n}: exactly one open PR`);
    assert.equal(open[0].number, 100, 'lowest PR number wins');
    assert.equal(results.filter((r) => r.ok).length, 1, 'only the winner succeeds');
    for (const r of results.filter((x) => !x.ok)) assert.match(r.stderr, /DUPLICATE_PUBLISH_RACE_LOST/);
    assert.equal(deleted.length, n - 1, 'each loser deletes only its own branch');
    assert.ok(!deleted.some((d) => d.endsWith(open[0].head.ref)), 'winner branch is never deleted');
  }
});

// ---------------------------------------------------------------------------------------------
// Durable claim (repair of the #34 review blocker): at-most-one live Draft must not depend on a
// losing runner surviving to run the tie-break step.

const claimScript = h.jobs.publish.steps.find((s) => s.id === 'claim').run;
const T0 = 1_800_000_000;
const claimEnv = (i, extra = {}) => ({
  BASE_SHA: 'a'.repeat(40), ATTEMPT: '1', GITHUB_RUN_ID: String(7000 + i), FAKE_NOW: String(T0), ...extra,
});

test('claim step: ordered between token mint and draft, never deletes, expiry outlives the publish job', () => {
  const steps = h.jobs.publish.steps;
  const idx = (pred) => steps.findIndex(pred);
  assert.ok(idx((s) => s.id === 'publisher') < idx((s) => s.id === 'claim'));
  assert.ok(idx((s) => s.id === 'claim') < idx((s) => s.id === 'draft'));
  assert.equal(steps.find((s) => s.id === 'claim').env.GH_TOKEN, '${{ steps.publisher.outputs.token }}');
  assert.match(draft, /CLAIM_REF/);
  assert.ok(draft.indexOf('CLAIM_REF') < draft.indexOf('git push'));
  assert.doesNotMatch(claimScript, /-X DELETE|-X PATCH|git push|pulls/);
  const ttl = Number(claimScript.match(/ttl=(\d+)/)[1]);
  assert.ok(ttl > h.jobs.publish['timeout-minutes'] * 60, 'a dead claimant can never act after its claim expires');
});

function claimOutcome(world, extra = {}, i = 0) {
  return h.runScript(world, claimScript, claimEnv(i, extra));
}

test('claim: first publisher acquires g1; an unexpired claim blocks; an expired one advances to g2', () => {
  const world = h.makeWorld({});
  try {
    const first = claimOutcome(world);
    assert.equal(first.ok, true, first.stderr);
    assert.equal(first.outputs.claim_ref, 'refs/tags/claude-claim/issue-12/g1');
    const held = claimOutcome(world, { FAKE_NOW: String(T0 + 1199) }, 1);
    assert.equal(held.ok, false);
    assert.match(held.stderr, /CLAIM_HELD/);
    const next = claimOutcome(world, { FAKE_NOW: String(T0 + 1200) }, 2);
    assert.equal(next.ok, true, next.stderr);
    assert.equal(next.outputs.claim_ref, 'refs/tags/claude-claim/issue-12/g2');
    // other Issues have their own chain (issue 12 vs 120 never collide)
    const other = h.runScript(world, claimScript, { ...claimEnv(3), ISSUE_NUMBER: '120' });
    assert.equal(other.outputs.claim_ref, 'refs/tags/claude-claim/issue-120/g1');
  } finally {
    world.cleanup();
  }
});

test('claim fails closed on API errors and unreadable or forged claim messages', () => {
  for (const fail of ['claims', 'claim-create']) {
    const world = h.makeWorld({});
    try {
      const r = claimOutcome(world, { FAKE_GH_FAIL: fail });
      assert.equal(r.ok, false, fail);
      assert.match(r.stderr, /CLAIM_(LOOKUP|CREATE)_FAILED/, fail);
    } finally { world.cleanup(); }
  }
  const world = h.makeWorld({});
  try {
    assert.equal(claimOutcome(world).ok, true);
    const unreadable = claimOutcome(world, { FAKE_GH_FAIL: 'claim-read', FAKE_NOW: String(T0 + 99999) }, 1);
    assert.equal(unreadable.ok, false, 'cannot read the latest claim: do not assume it is stale');
    const statePath = join(world.dir, 'claims-state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    for (const tag of Object.values(state.tags)) tag.message = 'forged without epoch';
    h.writeFileSync(statePath, JSON.stringify(state));
    const forged = claimOutcome(world, { FAKE_NOW: String(T0 + 99999) }, 2);
    assert.equal(forged.ok, false, 'claim without an epoch is never treated as expired');
    assert.match(forged.stderr, /CLAIM_HELD/);
  } finally { world.cleanup(); }
});

// A publisher flow = pre-mint guard -> claim -> create Draft -> (tie-break). `killAfter` simulates
// the runner being killed/cancelled/timed out (SIGKILL: no step after it runs, no cleanup).
function writeFlow(world, i, { killAfter = null, tieBreak = true } = {}) {
  const file = join(world.dir, `flow-${i}.sh`);
  const branch = BRANCH(12, 9000 + i);
  h.writeFileSync(join(world.dir, 'claim.sh'), claimScript);
  h.writeFileSync(join(world.dir, 'premint.sh'), premint);
  h.writeFileSync(join(world.dir, 'tiebreak.sh'), tiebreak);
  h.writeFileSync(file, [
    'set -euo pipefail',
    `bash "${join(world.dir, 'premint.sh')}"`,
    `bash "${join(world.dir, 'claim.sh')}"`,
    killAfter === 'claim' ? 'kill -KILL $$' : ':',
    `created="$(gh api -X POST "repos/$GITHUB_REPOSITORY/pulls" -f title=t -f head="${branch}" -f base=main -F draft=true -f body=b)"`,
    killAfter === 'post' ? 'kill -KILL $$' : ':',
    'export PR_NUMBER="$(jq -r .number <<< "$created")"',
    `export BRANCH="${branch}"`,
    tieBreak ? `bash "${join(world.dir, 'tiebreak.sh')}"` : ':',
  ].join('\n'));
  return file;
}
const openPrs = (world) => JSON.parse(readFileSync(join(world.dir, 'pulls-state.json'), 'utf8')).prs.filter((p) => p.state === 'open');

test('FAULT INJECTION: runner killed right after the PR POST, before the tie-break; the competing publisher cannot create a second Draft', async () => {
  const world = h.makeWorld({ dynamicPulls: [] });
  try {
    // Both publishers pass the pre-mint guard together (nothing exists yet), then race for the claim.
    const raceEnv = (i) => ({ ...claimEnv(i), FLOW_ID: String(i), BARRIER_N: '2', BARRIER_ON: 'claims' });
    const [a, b] = await Promise.all([
      h.spawnScript(world, writeFlow(world, 0, { killAfter: 'post' }), raceEnv(0)),
      h.spawnScript(world, writeFlow(world, 1, { killAfter: 'post' }), raceEnv(1)),
    ]);
    const killed = [a, b].filter((r) => r.status === 137 || r.status === null);
    const refused = [a, b].filter((r) => /CLAIM_(LOST|HELD)/.test(r.stderr));
    assert.equal(killed.length, 1, 'exactly one publisher won the claim and was killed after its POST');
    assert.equal(refused.length, 1, 'the other publisher was refused by the claim, not by cleanup');
    assert.equal(openPrs(world).length, 1, 'exactly one open Draft although the tie-break step never ran');
  } finally { world.cleanup(); }
});

test('FAULT INJECTION: 4 publishers race the claim; exactly one Draft, no tie-break needed', async () => {
  const world = h.makeWorld({ dynamicPulls: [] });
  try {
    const results = await Promise.all([0, 1, 2, 3].map((i) =>
      h.spawnScript(world, writeFlow(world, i, { tieBreak: false }), { ...claimEnv(i), FLOW_ID: String(i), BARRIER_N: '4', BARRIER_ON: 'claims' })));
    assert.equal(results.filter((r) => r.ok).length, 1);
    for (const r of results.filter((x) => !x.ok)) assert.match(r.stderr, /CLAIM_(LOST|HELD)/);
    assert.equal(openPrs(world).length, 1);
    const refs = Object.keys(JSON.parse(readFileSync(join(world.dir, 'claims-state.json'), 'utf8')).refs);
    assert.deepEqual(refs, ['refs/tags/claude-claim/issue-12/g1'], 'one atomic winner, no leftover claim');
  } finally { world.cleanup(); }
});

test('FAULT INJECTION: runner killed right after the claim, before any PR: no duplicate while held, automatic recovery after expiry', async () => {
  const world = h.makeWorld({ dynamicPulls: [] });
  try {
    const dead = await h.spawnScript(world, writeFlow(world, 0, { killAfter: 'claim' }), claimEnv(0));
    assert.ok(dead.status === 137 || dead.status === null, 'first publisher killed');
    assert.equal(openPrs(world).length, 0, 'nothing was published');
    const early = await h.spawnScript(world, writeFlow(world, 1), claimEnv(1, { FAKE_NOW: String(T0 + 600) }));
    assert.equal(early.ok, false);
    assert.match(early.stderr, /CLAIM_HELD/);
    assert.equal(openPrs(world).length, 0, 'still no Draft while the dead claim is unexpired (fail closed)');
    const recovered = await h.spawnScript(world, writeFlow(world, 2), claimEnv(2, { FAKE_NOW: String(T0 + 1300) }));
    assert.equal(recovered.ok, true, recovered.stderr);
    assert.equal(openPrs(world).length, 1, 'recovery produced exactly one Draft');
  } finally { world.cleanup(); }
});

test('FAULT INJECTION: first publisher killed after its POST; a later publisher after claim expiry is stopped by the open-PR guard', async () => {
  const world = h.makeWorld({ dynamicPulls: [] });
  try {
    const dead = await h.spawnScript(world, writeFlow(world, 0, { killAfter: 'post' }), claimEnv(0));
    assert.ok(dead.status === 137 || dead.status === null);
    assert.equal(openPrs(world).length, 1);
    const later = await h.spawnScript(world, writeFlow(world, 1), claimEnv(1, { FAKE_NOW: String(T0 + 5000) }));
    assert.equal(later.ok, false);
    assert.match(later.stderr, /DUPLICATE_PR_REJECTED/);
    assert.equal(openPrs(world).length, 1);
  } finally { world.cleanup(); }
});

test('tie-break fails closed when own PR is not visible and validates its inputs', () => {
  const world = h.makeWorld({ dynamicPulls: [] });
  try {
    const bad = h.runScript(world, tiebreak, { PR_NUMBER: '100', BRANCH: BRANCH(12) });
    assert.equal(bad.ok, false);
    assert.match(bad.stderr, /PUBLISH_STATE_UNKNOWN/);
    assert.equal(h.runScript(world, tiebreak, { PR_NUMBER: 'abc', BRANCH: BRANCH(12) }).ok, false);
    assert.equal(h.runScript(world, tiebreak, { PR_NUMBER: '100', BRANCH: 'main' }).ok, false);
    assert.equal(h.runScript(world, tiebreak, { PR_NUMBER: '100', BRANCH: BRANCH(13) }).ok, false, 'branch of another Issue');
  } finally {
    world.cleanup();
  }
});

test('publisher keeps Draft-only publishing, no extra scopes, and records the audited trigger', () => {
  const mint = h.jobs.publish.steps.find((s) => s.id === 'publisher');
  assert.equal(mint.with['permission-contents'], 'write');
  assert.equal(mint.with['permission-pull-requests'], 'write');
  assert.equal(mint.with['permission-workflows'], undefined);
  assert.equal(mint.with['permission-administration'], undefined);
  assert.match(draft, /-F draft=true/);
  assert.match(draft, /Trigger: command=\$COMMAND attempt=\$ATTEMPT\/3 comment=/);
  assert.match(draft, /branch="claude\/issue-\$ISSUE_NUMBER-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT"/, 'branch shape Reviewer/Repair parse');
  assert.equal(h.jobs.agent.permissions.contents, 'read');
  assert.ok(!JSON.stringify(h.jobs.agent).includes('secrets.BUILDER_PUBLISHER'));
});
