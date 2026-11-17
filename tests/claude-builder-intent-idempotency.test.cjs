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
  assert.ok(validateIdx < premintIdx && premintIdx < mintIdx && mintIdx < claimIdx && claimIdx < draftIdx);
  assert.ok(draft.indexOf('\nbot_pr_guard\n') < draft.indexOf('git push'));
  assert.ok(draft.indexOf('DUPLICATE_PR_REJECTED') < draft.indexOf('git push'));
  assert.equal(steps[premintIdx].env.GH_TOKEN, '${{ github.token }}', 'pre-mint check uses the read-only token');
  assert.equal(h.jobs.publish.permissions['pull-requests'], 'read');
  assert.equal(h.jobs.preflight.permissions['pull-requests'], 'read');
});

test('the PR guard is byte-identical in preflight and all publisher steps', () => {
  const reference = h.extractFunction(gate, 'bot_pr_guard');
  assert.ok(reference && reference.includes('--paginate'));
  for (const [name, script] of [['premint', premint], ['claim', claim], ['draft', draft]]) {
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


const BASE_SHA = 'a'.repeat(40);
const FIXED_REF = 'refs/builder-claims/issue-12';
const env = (over = {}) => ({ BASE_SHA, ...over });
const refsOf = world => JSON.parse(readFileSync(join(world.dir, 'refs-state.json'), 'utf8'));
const prsOf = world => JSON.parse(readFileSync(join(world.dir, 'pulls-state.json'), 'utf8')).prs;
const commitsOf = world => JSON.parse(readFileSync(join(world.dir, 'commits-state.json'), 'utf8'));
const metadataOf = world => JSON.parse(commitsOf(world)[refsOf(world)[FIXED_REF]].message);
const claimRun = (world, over = {}) => h.runScript(world, claim, env(over));
function seedClosedHolder(world) {
  const r = claimRun(world); assert.equal(r.ok, true, r.stderr);
  h.writeFileSync(join(world.dir, 'pulls-state.json'), JSON.stringify({ next: 101, prs: [h.pull(100, BRANCH(12), 'closed')] }));
  return r;
}
function prepareFlow(world) {
  h.writeFileSync(join(world.dir, 'claim.sh'), claim);
  h.writeFileSync(join(world.dir, 'flow.sh'), [
    'set -euo pipefail', `bash "${join(world.dir, 'claim.sh')}"`,
    'if [ -n "${DIE_AFTER_CLAIM:-}" ]; then kill -KILL $$; fi',
    'gh api -X POST "repos/$GITHUB_REPOSITORY/pulls" -f title=t -f head="$BRANCH" -f base=main -F draft=true -f body=b >/dev/null',
    'if [ -n "${DIE_AFTER_POST:-}" ]; then kill -KILL $$; fi',
  ].join('\n'));
}
function flow(world, run, extra = {}) {
  return h.spawnScript(world, join(world.dir, 'flow.sh'), env({
    GITHUB_RUN_ID: String(run), FLOW_ID: String(run), BRANCH: BRANCH(12, run), ...extra,
  }));
}

test('initial publish atomically creates one fixed Issue claim with bounded immutable identity', () => {
  const world = h.makeWorld({ dynamicPulls: [] });
  try {
    const r = claimRun(world); assert.equal(r.ok, true, r.stderr);
    assert.equal(r.outputs.ref, FIXED_REF); assert.match(r.outputs.sha, /^[0-9a-f]{40}$/);
    assert.match(r.outputs.metadata_hash, /^[0-9a-f]{64}$/);
    const m = metadataOf(world);
    assert.equal(m.schema, 'nexagnet-builder-claim-v1'); assert.equal(m.repository, h.REPO);
    assert.equal(m.issue_number, '12'); assert.equal(m.run_id, '7001'); assert.equal(m.attempt, 1);
    assert.equal(m.comment_id, '5000'); assert.equal(m.branch, BRANCH(12));
    assert.match(m.nonce, /^[0-9a-f]{32}$/); assert.equal(m.previous_claim_sha, null);
    const again = claimRun(world); assert.equal(again.ok, false); assert.match(again.stderr, /CLAIM_REPLAY_REJECTED/);
  } finally { world.cleanup(); }
});

test('published holder must be exactly one same-repo closed-unmerged PR before a bounded explicit retry', () => {
  for (const state of ['absent', 'open', 'merged', 'fork', 'multiple', 'closed']) {
    const world = h.makeWorld({ dynamicPulls: [] });
    try {
      const seed = seedClosedHolder(world), old = seed.outputs.sha;
      let prs = [h.pull(100, BRANCH(12), 'closed')];
      if (state === 'absent') prs = [];
      if (state === 'open') prs[0].state = 'open';
      if (state === 'merged') prs[0].merged_at = '2026-01-01';
      if (state === 'fork') prs[0].head.repo.full_name = 'attacker/example';
      if (state === 'multiple') prs.push(h.pull(101, BRANCH(12), 'closed'));
      h.writeFileSync(join(world.dir, 'pulls-state.json'), JSON.stringify({ next: 102, prs }));
      const r = claimRun(world, { COMMAND: 'retry', ATTEMPT: '2', COMMENT_ID: '5100', GITHUB_RUN_ID: '7002' });
      assert.equal(r.ok, state === 'closed', state + r.stderr);
      if (state === 'closed') {
        assert.equal(metadataOf(world).previous_claim_sha, old);
        assert.equal(metadataOf(world).attempt, 2);
        assert.match(readFileSync(join(world.dir, 'calls.log'), 'utf8'), /force=false/);
      } else assert.equal(refsOf(world)[FIXED_REF], old, 'old claim survives rejection');
    } finally { world.cleanup(); }
  }
});

test('retries reject old comment, consumed attempt, wrong command and exhausted budget', () => {
  const world = h.makeWorld({ dynamicPulls: [] });
  try {
    const seed = seedClosedHolder(world);
    for (const over of [{ COMMAND: 'retry', ATTEMPT: '2', COMMENT_ID: '5000' },
      { COMMAND: 'retry', ATTEMPT: '1', COMMENT_ID: '5100' }, { COMMAND: 'run', ATTEMPT: '2', COMMENT_ID: '5100' },
      { COMMAND: 'retry', ATTEMPT: '4', COMMENT_ID: '5100' }]) {
      assert.equal(claimRun(world, over).ok, false, JSON.stringify(over));
      assert.equal(refsOf(world)[FIXED_REF], seed.outputs.sha);
    }
    // Intermediate BLOCKED/NO_PATCH consumes a comment attempt without claiming: final retry may advance to 3.
    assert.equal(claimRun(world, { COMMAND: 'retry', ATTEMPT: '3', COMMENT_ID: '5200', GITHUB_RUN_ID: '7003' }).ok, true);
    assert.equal(metadataOf(world).attempt, 3);
  } finally { world.cleanup(); }
});

test('no earlier publish claim permits explicit retry after BLOCKED or NO_PATCH without a fake prior PR', () => {
  const world = h.makeWorld({ dynamicPulls: [] });
  try {
    const r = claimRun(world, { COMMAND: 'retry', ATTEMPT: '2', COMMENT_ID: '5100' });
    assert.equal(r.ok, true, r.stderr); assert.equal(metadataOf(world).attempt, 2);
    assert.equal(metadataOf(world).previous_claim_sha, null);
  } finally { world.cleanup(); }
});

test('invalid matching records and duplicated pagination cannot become a new generation', () => {
  const duplicate = h.pull(100, BRANCH(12), 'closed');
  const world = h.makeWorld({ pulls: [[duplicate], [duplicate]] });
  try { assert.equal(claimRun(world).ok, false); }
  finally { world.cleanup(); }
  assert.doesNotMatch(claim, /claim=.*(?:gen-|PR_TOTAL)/);
});

test('retry keeps the original claim tree when the current code/workflow base changed', () => {
  const world = h.makeWorld({ dynamicPulls: [] });
  try {
    const seed = seedClosedHolder(world), commits = commitsOf(world), nextBase = 'd'.repeat(40);
    commits[nextBase] = { sha: nextBase, tree: { sha: 'e'.repeat(40) }, parents: [], message: 'new workflow version' };
    h.writeFileSync(join(world.dir, 'commits-state.json'), JSON.stringify(commits));
    const r = claimRun(world, { BASE_SHA: nextBase, COMMAND: 'retry', ATTEMPT: '2', COMMENT_ID: '5100' });
    assert.equal(r.ok, true, r.stderr);
    const updated = commitsOf(world)[r.outputs.sha];
    assert.equal(updated.tree.sha, commits[seed.outputs.sha].tree.sha);
    assert.equal(JSON.parse(updated.message).base_sha, nextBase);
    assert.equal(updated.parents[0].sha, seed.outputs.sha);
  } finally { world.cleanup(); }
});

test('malformed immutable metadata and API failures never advance the claim', () => {
  for (const mutate of [m => { m.attempt = 4; }, m => { m.run_attempt = '2'; },
    m => { m.comment_id = 'not-numeric'; }, m => { m.branch = 'main'; },
    m => { m.previous_claim_sha = 'b'.repeat(40); }, m => { m.nonce = {}; }]) {
    const world = h.makeWorld({ dynamicPulls: [] });
    try {
      const seed = seedClosedHolder(world), commits = commitsOf(world);
      const m = JSON.parse(commits[seed.outputs.sha].message); mutate(m);
      commits[seed.outputs.sha].message = JSON.stringify(m);
      h.writeFileSync(join(world.dir, 'commits-state.json'), JSON.stringify(commits));
      const r = claimRun(world, { COMMAND: 'retry', ATTEMPT: '2', COMMENT_ID: '5100' });
      assert.equal(r.ok, false); assert.match(r.stderr, /PUBLISH_CLAIM_INVALID/);
      assert.equal(refsOf(world)[FIXED_REF], seed.outputs.sha);
    } finally { world.cleanup(); }
  }
  for (const fail of ['pulls', 'pulls-garbage', 'ref-get', 'commit', 'claim']) {
    const world = h.makeWorld({ dynamicPulls: [] });
    try { assert.equal(claimRun(world, { FAKE_GH_FAIL: fail }).ok, false, fail); }
    finally { world.cleanup(); }
  }
});

test('malformed parent SHA cannot validate by matching equally malformed metadata', () => {
  const world = h.makeWorld({ dynamicPulls: [] });
  try {
    const seed = seedClosedHolder(world), commits = commitsOf(world), record = commits[seed.outputs.sha];
    const m = JSON.parse(record.message); m.previous_claim_sha = 'invalid';
    record.message = JSON.stringify(m); record.parents[0].sha = 'invalid';
    h.writeFileSync(join(world.dir, 'commits-state.json'), JSON.stringify(commits));
    const r = claimRun(world, { COMMAND: 'retry', ATTEMPT: '2', COMMENT_ID: '5100' });
    assert.equal(r.ok, false); assert.match(r.stderr, /PUBLISH_CLAIM_INVALID/);
    assert.equal(refsOf(world)[FIXED_REF], seed.outputs.sha);
  } finally { world.cleanup(); }
});

test('initial racers killed after PR POST cannot strand two Drafts and closed-holder retry recovers', async () => {
  for (const n of [2, 4]) {
    const world = h.makeWorld({ dynamicPulls: [] });
    try {
      prepareFlow(world);
      const results = await Promise.all(Array.from({ length: n }, (_, i) => flow(world, 9000 + i, { BARRIER_N: String(n), DIE_AFTER_POST: '1' })));
      assert.equal(results.filter(r => r.status === null).length, 1);
      assert.equal(prsOf(world).length, 1); assert.equal(prsOf(world).filter(p => p.state === 'open').length, 1);
      assert.deepEqual(Object.keys(refsOf(world)), [FIXED_REF]);
      const reject = await flow(world, 9100, { COMMAND: 'retry', ATTEMPT: '2', COMMENT_ID: '5100' });
      assert.equal(reject.ok, false);
      const prs = prsOf(world); prs[0].state = 'closed';
      h.writeFileSync(join(world.dir, 'pulls-state.json'), JSON.stringify({ next: 101, prs }));
      const retry = await flow(world, 9101, { COMMAND: 'retry', ATTEMPT: '2', COMMENT_ID: '5100' });
      assert.equal(retry.ok, true, retry.stderr);
      assert.equal(prsOf(world).filter(p => p.state === 'open').length, 1);
    } finally { world.cleanup(); }
  }
});

test('concurrent retry sibling commits use non-force CAS: exactly one advances and publishes', async () => {
  const world = h.makeWorld({ dynamicPulls: [] });
  try {
    const seed = seedClosedHolder(world); prepareFlow(world);
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => flow(world, 9200 + i, {
      BARRIER_N: '4', CAS_BARRIER_N: '4', COMMAND: 'retry', ATTEMPT: '2', COMMENT_ID: '5100',
    })));
    assert.equal(results.filter(r => r.ok).length, 1, results.map(r => r.stderr).join('\n'));
    for (const r of results.filter(r => !r.ok)) assert.match(r.stderr, /PUBLISH_CLAIM_REJECTED/);
    const descendants = Object.values(commitsOf(world)).filter(c => c.parents[0]?.sha === seed.outputs.sha);
    assert.equal(descendants.length, 4, 'distinct nonces create four sibling claims');
    assert.equal(new Set(descendants.map(c => JSON.parse(c.message).nonce)).size, 4);
    assert.equal(prsOf(world).filter(p => p.state === 'open').length, 1);
  } finally { world.cleanup(); }
});

test('identical retry run identity still creates distinct nonce sibling commits', async () => {
  const world = h.makeWorld({ dynamicPulls: [] });
  try {
    const seed = seedClosedHolder(world); prepareFlow(world);
    const results = await Promise.all(Array.from({ length: 2 }, (_, i) => flow(world, 9400, {
      FLOW_ID: 'same-' + i, BARRIER_N: '2', CAS_BARRIER_N: '2',
      COMMAND: 'retry', ATTEMPT: '2', COMMENT_ID: '5100',
    })));
    assert.equal(results.filter(r => r.ok).length, 1, results.map(r => r.stderr).join('\n'));
    const children = Object.values(commitsOf(world)).filter(c => c.parents[0]?.sha === seed.outputs.sha);
    assert.equal(children.length, 2);
    assert.equal(new Set(children.map(c => JSON.parse(c.message).nonce)).size, 2);
    assert.equal(prsOf(world).filter(p => p.state === 'open').length, 1);
  } finally { world.cleanup(); }
});

test('kill after claiming but before POST strands the fixed slot; no automatic steal or cleanup', async () => {
  const world = h.makeWorld({ dynamicPulls: [] });
  try {
    prepareFlow(world); const dead = await flow(world, 9300, { DIE_AFTER_CLAIM: '1' });
    assert.equal(dead.status, null); const sha = refsOf(world)[FIXED_REF];
    const retry = await flow(world, 9301, { COMMAND: 'retry', ATTEMPT: '2', COMMENT_ID: '5100' });
    assert.equal(retry.ok, false); assert.match(retry.stderr, /PUBLISH_CLAIM_STRANDED/);
    assert.equal(prsOf(world).length, 0); assert.equal(refsOf(world)[FIXED_REF], sha);
    assert.doesNotMatch(claim, /-X DELETE|force=true/);
  } finally { world.cleanup(); }
});

test('draft verifies live SHA and immutable ownership before push and again before PR POST', () => {
  const world = h.makeWorld({ dynamicPulls: [] });
  try {
    const seed = claimRun(world); assert.equal(seed.ok, true, seed.stderr);
    const prefix = draft.slice(0, draft.indexOf('# Last look'));
    const own = { CLAIM_REF: seed.outputs.ref, CLAIM_SHA: seed.outputs.sha, CLAIM_METADATA_HASH: seed.outputs.metadata_hash };
    assert.equal(h.runScript(world, prefix, env(own)).ok, true);
    for (const over of [{ CLAIM_SHA: 'f'.repeat(40) }, { CLAIM_METADATA_HASH: 'f'.repeat(64) }, { GITHUB_RUN_ID: '9999' }]) {
      const r = h.runScript(world, prefix, env({ ...own, ...over }));
      assert.equal(r.ok, false); assert.match(r.stderr, /CLAIM_OWNERSHIP_REJECTED/);
    }
    assert.equal((draft.match(/verify_own_claim \|\|/g) || []).length, 2);
    assert.doesNotMatch(h.source, /Resolve publish race|DUPLICATE_PUBLISH_RACE_LOST/);
  } finally { world.cleanup(); }
});

test('actual Draft step rejects lost claim after push and publishes once when it still owns the slot', () => {
  for (const loseClaim of [true, false]) {
    const world = h.makeWorld({ dynamicPulls: [] });
    try {
      const seed = claimRun(world); assert.equal(seed.ok, true, seed.stderr);
      h.writeFileSync(join(world.bin, 'git'), [
        '#!/bin/bash', 'set -euo pipefail', 'case "$1" in',
        '  rev-parse) printf "%s\n" "$BASE_SHA" ;;',
        '  check-ref-format|switch|-c) ;;',
        '  push)',
        '    if [ "$LOSE_CLAIM" = 1 ]; then printf \'{"refs/builder-claims/issue-12":"%040d"}\' 0 > "$FAKE_GH_DIR/refs-state.json"; fi ;;',
        '  *) exit 2 ;;', 'esac', '',
      ].join('\n'), { mode: 0o755 });
      const r = h.runScript(world, draft, env({
        CLAIM_REF: seed.outputs.ref, CLAIM_SHA: seed.outputs.sha, CLAIM_METADATA_HASH: seed.outputs.metadata_hash,
        BASE_BRANCH: 'main', RISK: '1', GITHUB_SERVER_URL: 'https://github.com', LOSE_CLAIM: loseClaim ? '1' : '0',
      }));
      assert.equal(r.ok, !loseClaim, r.stderr);
      assert.equal(prsOf(world).length, loseClaim ? 0 : 1);
      if (loseClaim) assert.match(r.stderr, /CLAIM_OWNERSHIP_REJECTED: live claim changed before PR creation/);
      else assert.equal(r.outputs.branch, BRANCH(12));
    } finally { world.cleanup(); }
  }
});

test('fixed per-Issue claim cannot derive its unique ref from mutable paginated PR totals', () => {
  assert.doesNotMatch(claim, /gen-\$\{PR_TOTAL\}/);
  assert.match(claim, /claim="refs\/builder-claims\/issue-\$\{ISSUE_NUMBER\}"/);
  assert.match(claim, /force=false/);
});

test('matching PR records with malformed state, identity or merge status fail closed', () => {
  for (const mutate of [p => { delete p.state; }, p => { p.state = 'unknown'; },
    p => { p.number = '166'; }, p => { delete p.merged_at; }]) {
    const pr = h.pull(166, BRANCH(12), 'closed'); mutate(pr);
    const world = h.makeWorld({ pulls: [[pr]] });
    try { assert.equal(h.runScript(world, premint).ok, false, JSON.stringify(pr)); }
    finally { world.cleanup(); }
  }
});

test('draft revalidates the live immutable claim identity before pushing', () => {
  const step = h.jobs.publish.steps.find(s => s.id === 'draft');
  assert.equal(step.env.CLAIM_SHA, '\$' + '{{ steps.claim.outputs.sha }}');
  assert.match(draft, /CLAIM_OWNERSHIP_REJECTED/);
  assert.ok(draft.indexOf('CLAIM_OWNERSHIP_REJECTED') < draft.indexOf('git push origin'));
});
