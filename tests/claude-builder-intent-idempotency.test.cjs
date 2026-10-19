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
const claim = h.jobs.publish.steps.find((s) => s.id === 'claim').run;
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
  const claimIdx = idx((s) => s.id === 'claim');
  const tieIdx = idx((s) => s.name?.startsWith('Resolve publish race'));
  assert.ok(validateIdx < premintIdx && premintIdx < mintIdx && mintIdx < claimIdx && claimIdx < draftIdx && draftIdx < tieIdx);
  assert.ok(draft.indexOf('\nbot_pr_guard\n') < draft.indexOf('git push'));
  assert.ok(draft.indexOf('DUPLICATE_PR_REJECTED') < draft.indexOf('git push'));
  assert.equal(steps[premintIdx].env.GH_TOKEN, '${{ github.token }}', 'pre-mint check uses the read-only token');
  assert.equal(h.jobs.publish.permissions['pull-requests'], 'read');
  assert.equal(h.jobs.preflight.permissions['pull-requests'], 'read');
});

test('the PR guard is byte-identical in preflight and all publisher steps', () => {
  const reference = h.extractFunction(gate, 'bot_pr_guard');
  assert.ok(reference && reference.includes('--paginate'));
  for (const [name, script] of [['premint', premint], ['claim', claim], ['draft', draft], ['tiebreak', tiebreak]]) {
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

// ---------------------------------------------------------------------------------------------------------------
// Durable at-most-one (review of PR #34): the invariant must NOT depend on a losing runner surviving to run a later
// tie-break. A publisher is simulated as a separate OS process that is SIGKILLed at a chosen point (a cancelled or
// crashed runner); the fake GitHub enforces atomic, exclusive ref creation exactly like the real API (422).
// Synthetic data only; the real claim/publish shell is what executes. NOT live GitHub Actions proof.
// ---------------------------------------------------------------------------------------------------------------
const BASE_SHA = 'a'.repeat(40);
const CLAIM_REF = (issueNo, gen) => `refs/builder-claims/issue-${issueNo}-gen-${gen}`;

function prepareFlows(world) {
  h.writeFileSync(join(world.dir, 'claim.sh'), claim);
  h.writeFileSync(join(world.dir, 'premint.sh'), premint);
  h.writeFileSync(join(world.dir, 'tiebreak.sh'), tiebreak);
  h.writeFileSync(join(world.dir, 'flow.sh'), [
    'set -euo pipefail',
    'if [ -n "${LEGACY:-}" ]; then',
    `  bash "${join(world.dir, 'premint.sh')}"`,
    'else',
    `  bash "${join(world.dir, 'claim.sh')}"`,
    '  if [ -n "${DIE_AFTER_CLAIM:-}" ]; then kill -KILL $$; fi',
    'fi',
    'created="$(gh api -X POST "repos/$GITHUB_REPOSITORY/pulls" -f title=t -f head="$BRANCH" -f base=main -F draft=true -f body=b)"',
    'if [ -n "${DIE_AFTER_POST:-}" ]; then kill -KILL $$; fi',
    'export PR_NUMBER="$(jq -r .number <<< "$created")"',
    `bash "${join(world.dir, 'tiebreak.sh')}"`,
  ].join('\n'));
}
const flowEnv = (extra = {}) => ({ BASE_SHA, ...extra });
const runFlows = (world, n, perFlow = () => ({})) => Promise.all(
  Array.from({ length: n }, (_, i) => h.spawnScript(world, join(world.dir, 'flow.sh'), flowEnv({
    FLOW_ID: String(i), BARRIER_N: String(n), BRANCH: BRANCH(12, 9000 + i), ...perFlow(i),
  })))
);
const runOne = (world, run, extra = {}) =>
  h.spawnScript(world, join(world.dir, 'flow.sh'), flowEnv({ FLOW_ID: `one-${run}`, BRANCH: BRANCH(12, run), ...extra }));
const prsOf = (world) => JSON.parse(readFileSync(join(world.dir, 'pulls-state.json'), 'utf8')).prs;
const claimsOf = (world) => {
  const f = join(world.dir, 'refs-state.json');
  return existsSync(f) ? Object.keys(JSON.parse(readFileSync(f, 'utf8'))) : [];
};
const killed = (r) => r.status === null;

test('FAULT INJECTION: a publisher killed right after its PR was created cannot leave a second open Draft (and recovery works)', async () => {
  for (const n of [2, 4]) {
    const world = h.makeWorld({ dynamicPulls: [] });
    try {
      prepareFlows(world);
      // Every racer passes every guard together (barrier), then whichever owns the claim creates its PR and is killed
      // BEFORE the tie-break could run. The previous design would strand all n PRs in that case.
      const results = await runFlows(world, n, () => ({ DIE_AFTER_POST: '1' }));
      assert.equal(results.filter(killed).length, 1, `n=${n}: only the claim holder reached the PR POST and was killed`);
      const rejected = results.filter((r) => !killed(r));
      assert.equal(rejected.length, n - 1);
      for (const r of rejected) {
        assert.equal(r.ok, false);
        assert.match(r.stderr, /PUBLISH_CLAIM_REJECTED/);
      }
      assert.equal(prsOf(world).length, 1, 'no loser ever created a PR');
      assert.equal(prsOf(world).filter((p) => p.state === 'open').length, 1, 'exactly one open Draft survives the kill');
      assert.deepEqual(claimsOf(world), [CLAIM_REF(12, 0)]);

      if (n === 2) {
        // Recovery path: a later retry is refused while the stranded Draft is open...
        const refused = await runOne(world, 9100);
        assert.equal(refused.ok, false);
        assert.match(refused.stderr, /DUPLICATE_PR_REJECTED/);
        assert.equal(prsOf(world).length, 1);
        // ...and once the owner closes that Draft, the retry takes the NEXT generation and publishes exactly one PR.
        const close = h.runScript(world, 'gh api -X PATCH "repos/$GITHUB_REPOSITORY/pulls/100" -f state=closed');
        assert.equal(close.ok, true, close.stderr);
        const retry = await runOne(world, 9101);
        assert.equal(retry.ok, true, retry.stderr);
        assert.equal(prsOf(world).filter((p) => p.state === 'open').length, 1);
        assert.deepEqual(claimsOf(world).sort(), [CLAIM_REF(12, 0), CLAIM_REF(12, 1)]);
      }
    } finally {
      world.cleanup();
    }
  }
});

test('regression sensitivity: the former tie-break-only flow DOES strand every Draft when the runners are killed after the POST', async () => {
  const world = h.makeWorld({ dynamicPulls: [] });
  try {
    prepareFlows(world);
    const results = await runFlows(world, 2, () => ({ LEGACY: '1', DIE_AFTER_POST: '1' }));
    assert.equal(results.filter(killed).length, 2);
    assert.equal(prsOf(world).filter((p) => p.state === 'open').length, 2, 'this is the defect the claim step removes');
  } finally {
    world.cleanup();
  }
});

test('FAULT INJECTION: a publisher killed after claiming but before any PR strands only a claim; fail closed, owner release recovers', async () => {
  const world = h.makeWorld({ dynamicPulls: [] });
  try {
    prepareFlows(world);
    const dead = await runOne(world, 9200, { DIE_AFTER_CLAIM: '1' });
    assert.equal(killed(dead), true);
    assert.deepEqual(claimsOf(world), [CLAIM_REF(12, 0)]);
    assert.equal(prsOf(world).length, 0, 'no PR was created');
    const blocked = await runOne(world, 9201);
    assert.equal(blocked.ok, false);
    assert.match(blocked.stderr, /PUBLISH_CLAIM_REJECTED/);
    assert.equal(prsOf(world).length, 0, 'fails closed: still no PR, never a second one');
    // Owner releases exactly that stranded ref; the retry then publishes exactly one Draft.
    const release = h.runScript(world, 'gh api -X DELETE "repos/$GITHUB_REPOSITORY/git/refs/builder-claims/issue-12-gen-0"');
    assert.equal(release.ok, true, release.stderr);
    assert.deepEqual(claimsOf(world), []);
    const retry = await runOne(world, 9202);
    assert.equal(retry.ok, true, retry.stderr);
    assert.equal(prsOf(world).filter((p) => p.state === 'open').length, 1);
  } finally {
    world.cleanup();
  }
});

test('claim step executes: generation counts earlier Builder PRs of THIS Issue only', () => {
  const run = (pulls, env = {}) => {
    const world = h.makeWorld({ pulls });
    try {
      const r = h.runScript(world, claim, { BASE_SHA, ...env });
      return { ...r, calls: readFileSync(join(world.dir, 'calls.log'), 'utf8'), claims: claimsOf(world) };
    } finally {
      world.cleanup();
    }
  };
  const fresh = run([[]]);
  assert.equal(fresh.ok, true, fresh.stderr);
  assert.equal(fresh.outputs.ref, CLAIM_REF(12, 0));
  const afterClosed = run([[h.pull(166, BRANCH(12), 'closed'), h.pull(167, BRANCH(13), 'open'), h.pull(168, 'feature/x', 'open')]]);
  assert.equal(afterClosed.ok, true, afterClosed.stderr);
  assert.equal(afterClosed.outputs.ref, CLAIM_REF(12, 1), 'one earlier PR of Issue 12; other Issues and branches are not counted');
  assert.match(afterClosed.calls, /-X POST repos\/nexagnet\/example\/git\/refs /);
});

test('claim step fails closed and creates NO claim on an open/merged PR, lookup errors, API errors or a bad base SHA', () => {
  const run = (pulls, env = {}) => {
    const world = h.makeWorld({ pulls });
    try {
      const r = h.runScript(world, claim, { BASE_SHA, ...env });
      return { ...r, calls: readFileSync(join(world.dir, 'calls.log'), 'utf8'), claims: claimsOf(world) };
    } finally {
      world.cleanup();
    }
  };
  for (const pulls of [[[h.pull(166, BRANCH(12), 'open')]], [[h.pull(166, BRANCH(12), 'closed', { merged: true })]]]) {
    const r = run(pulls);
    assert.equal(r.ok, false);
    assert.match(r.stderr, /DUPLICATE_PR_REJECTED/);
    assert.doesNotMatch(r.calls, /git\/refs/, 'no claim is attempted');
  }
  for (const fail of ['pulls', 'pulls-garbage']) {
    const r = run([[]], { FAKE_GH_FAIL: fail });
    assert.equal(r.ok, false, fail);
    assert.match(r.stderr, /PR_LOOKUP_FAILED/, fail);
    assert.doesNotMatch(r.calls, /git\/refs/, fail);
  }
  const api = run([[]], { FAKE_GH_FAIL: 'claim' });
  assert.equal(api.ok, false);
  assert.match(api.stderr, /PUBLISH_CLAIM_FAILED/);
  assert.equal(api.outputs.ref, undefined, 'no ref is exported when the claim failed');
  for (const bad of ['', 'main', 'A'.repeat(40), 'a'.repeat(39)]) {
    const r = run([[]], { BASE_SHA: bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.doesNotMatch(r.calls, /git\/refs/, JSON.stringify(bad));
  }
  assert.equal(run([[]], { ISSUE_NUMBER: '0' }).ok, false);
  assert.equal(run([[]], { ISSUE_NUMBER: '12; id' }).ok, false);
});

test('claim step is wired between the publisher token and the push, and the push cannot run without it', () => {
  const steps = h.jobs.publish.steps;
  const claimStep = steps.find((s) => s.id === 'claim');
  const draftStep = steps.find((s) => s.id === 'draft');
  assert.equal(claimStep.env.GH_TOKEN, '${{ steps.publisher.outputs.token }}', 'uses the already-minted publisher token');
  assert.equal(h.jobs.publish.permissions['pull-requests'], 'read', 'job token stays read-only');
  assert.doesNotMatch(claim, /git push|git switch|git commit|-X PATCH|-X DELETE/, 'the claim step never pushes, edits or deletes');
  assert.equal(draftStep.env.CLAIM_REF, '${{ steps.claim.outputs.ref }}');
  assert.ok(draft.indexOf('CLAIM_REF') > -1 && draft.indexOf('CLAIM_REF') < draft.indexOf('\nbot_pr_guard\n'), 'claim is verified before the guard and the push');
  assert.ok(draft.indexOf('CLAIM_REF') < draft.indexOf('git push'));
  const mint = steps.find((s) => s.id === 'publisher');
  assert.equal(mint.with['permission-contents'], 'write');
  assert.equal(mint.with['permission-workflows'], undefined);
  assert.equal(mint.with['permission-administration'], undefined);
});

test('the draft step refuses to publish without a matching claim, before any lookup or push', () => {
  for (const ref of ['', 'refs/builder-claims/issue-13-gen-0', 'refs/heads/main', 'refs/builder-claims/issue-12-gen-x']) {
    const world = h.makeWorld({ dynamicPulls: [] });
    try {
      const r = h.runScript(world, draft, { COMMAND: 'run', ATTEMPT: '1', COMMENT_ID: '5000', CLAIM_REF: ref });
      assert.equal(r.ok, false, JSON.stringify(ref));
      assert.doesNotMatch(readFileSync(join(world.dir, 'calls.log'), 'utf8'), /pulls|git\/refs/, 'nothing is looked up or created: ' + JSON.stringify(ref));
    } finally {
      world.cleanup();
    }
  }
});
