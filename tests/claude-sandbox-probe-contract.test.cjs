'use strict';
// R3 #32: trusted negative sandbox probe. Executes the real inline shell (setup, probe, hook,
// verdict) on synthetic data. This file proves the PROBE MACHINERY is sound; it does NOT prove
// the Claude sandbox itself. That requires a live run (see docs/engineering/central-claude-sandbox-probe.md).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { createHash } = require('node:crypto');

const load = (name) => {
  const path = resolve(__dirname, '../.github/workflows', name);
  return {
    source: readFileSync(path, 'utf8'),
    data: JSON.parse(execFileSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.load_file(ARGV[0]))', path], { encoding: 'utf8' })),
  };
};
const probeWf = load('claude-sandbox-probe.yml');
const builderWf = load('claude-builder.yml');
const job = probeWf.data.jobs.probe;
const step = (name) => job.steps.find((s) => s.name?.startsWith(name));
const setup = step('Prepare synthetic canaries').run;
const decide = step('Decide from trusted evidence only').run;
const gate = step('Gate owner-triggered').run;
const claude = job.steps.find((s) => s.id === 'claude');
const builderClaude = builderWf.data.jobs.agent.steps.find((s) => s.id === 'claude');

// ---------------------------------------------------------------- static contract

test('probe is a manual, secret-minimal reusable workflow with no write path', () => {
  const callBlock = probeWf.data.on?.workflow_call ?? probeWf.data.true?.workflow_call;
  assert.ok(callBlock);
  assert.deepEqual(Object.keys(callBlock.secrets), ['CLAUDE_CODE_OAUTH_TOKEN']);
  assert.deepEqual(probeWf.data.permissions, {});
  assert.deepEqual(job.permissions, { contents: 'read', issues: 'read', 'pull-requests': 'read' });
  for (const forbidden of ['secrets.BUILDER_PUBLISHER', 'secrets.AUTOPILOT_APP', 'secrets: inherit', 'id-token', 'create-github-app-token', 'permission-workflows', 'contents: write', 'pull-requests: write']) {
    assert.ok(!probeWf.source.includes(forbidden), forbidden);
  }
  assert.doesNotMatch(probeWf.source, /gh pr create|git push|git commit|-X POST|-X PUT|-X PATCH|-X DELETE/);
  const pins = [...probeWf.source.matchAll(/uses:\s*[\w.-]+\/[\w.-]+@([0-9a-f]{40})/g)];
  assert.ok(pins.length >= 3);
  assert.equal([...probeWf.source.matchAll(/uses:\s*\S+/g)].length, pins.length, 'every action pinned to a full SHA');
});

test('probe runs under the SAME action pin, runner, scrub and bwrap bootstrap as the Builder agent', () => {
  assert.equal(job['runs-on'], builderWf.data.jobs.agent['runs-on']);
  assert.equal(job.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, builderWf.data.jobs.agent.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB);
  assert.equal(claude.uses, builderClaude.uses, 'same Claude Code Action SHA');
  assert.equal(claude.with.show_full_output, 'false');
  for (const name of ['Install bubblewrap for isolated Claude subprocesses', 'Verify strict bwrap network sandbox before Claude']) {
    const mine = job.steps.find((s) => s.name === name);
    const theirs = builderWf.data.jobs.agent.steps.find((s) => s.name === name);
    assert.ok(mine && theirs, name);
    assert.equal(mine.run, theirs.run, name + ' must be byte-identical');
  }
});

test('probe sandbox settings equal the Builder settings plus ONLY the declared additions', () => {
  const mine = JSON.parse(claude.with.settings);
  const theirs = JSON.parse(builderClaude.with.settings);
  const norm = (s) => JSON.parse(JSON.stringify(s).replaceAll('${{ runner.temp }}', '$TMP'));
  const m = norm(mine);
  const t = norm(theirs);
  for (const key of ['enabled', 'failIfUnavailable', 'allowUnsandboxedCommands', 'autoAllowBashIfSandboxed']) assert.equal(m.sandbox[key], t.sandbox[key], key);
  assert.deepEqual(m.sandbox.network, t.sandbox.network);
  assert.deepEqual(m.sandbox.filesystem.denyWrite, t.sandbox.filesystem.denyWrite);
  assert.deepEqual(m.permissions, t.permissions);
  // additions: evidence store is unreadable from the sandbox; one extra denied canary name
  assert.deepEqual(m.sandbox.filesystem.denyRead, [...t.sandbox.filesystem.denyRead, '$TMP/probe/private']);
  assert.deepEqual(m.sandbox.credentials.envVars, [...t.sandbox.credentials.envVars, { name: 'NEXAGNET_PROBE_CANARY_DENIED', mode: 'deny' }]);
  assert.equal(m.sandbox.network.allowedDomains.length, 0, 'no network allowlist expansion');
  assert.equal(m.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(Object.keys(m).sort(), ['hooks', 'permissions', 'sandbox']);
});

test('model is confined to ONE exact Bash command; file/web tools are disallowed; hooks cover Pre/Post/PostFailure', () => {
  const args = claude.with.claude_args;
  assert.match(args, /--allowedTools "Bash\(bash \$\{\{ runner\.temp \}\}\/probe\/public\/probe\.sh\)"/);
  assert.equal((args.match(/--allowedTools/g) || []).length, 1);
  for (const tool of ['WebFetch', 'WebSearch', 'Write', 'Edit', 'NotebookEdit', 'Read', 'Glob', 'Grep']) assert.match(args, new RegExp('--disallowedTools "[^"]*\\b' + tool + '\\b'));
  assert.doesNotMatch(args, /dangerously|--permission-mode|bypass/i);
  const hooks = JSON.parse(claude.with.settings).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PostToolUseFailure', 'PreToolUse']);
  for (const event of Object.keys(hooks)) {
    assert.equal(hooks[event][0].matcher, 'Bash');
    assert.equal(hooks[event][0].hooks[0].command, 'bash ${{ runner.temp }}/probe/private/hook.sh');
  }
  assert.match(claude.with.prompt, /exactly one Bash command/);
  assert.doesNotMatch(claude.with.prompt, /secret|token|canary/i, 'prompt carries no sensitive names');
});

test('decision runs after Claude even on failure; no model output feeds the verdict', () => {
  const idx = (pred) => job.steps.findIndex(pred);
  const decideIdx = idx((s) => s.name?.startsWith('Decide from trusted'));
  assert.ok(idx((s) => s.id === 'claude') < decideIdx);
  assert.equal(job.steps[decideIdx].if, 'always()');
  assert.doesNotMatch(decide, /steps\.claude|structured_output|execution_file|\$\{\{/);
  assert.ok(idx((s) => s.name?.startsWith('Prepare synthetic')) < idx((s) => s.id === 'claude'));
});

test('gate: owner + workflow_dispatch + default branch only, never the control-plane repo', () => {
  const run = (env, defaultBranch = 'main') => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-gate-'));
    try {
      mkdirSync(join(dir, 'bin'));
      writeFileSync(join(dir, 'bin/gh'), `#!/bin/bash\necho ${defaultBranch}\n`, { mode: 0o755 });
      return spawnSync('bash', ['-c', gate], {
        env: { ...process.env, PATH: join(dir, 'bin') + ':' + process.env.PATH, GH_TOKEN: 'x', GITHUB_REPOSITORY_OWNER: 'nexagnet',
          GITHUB_REPOSITORY: 'nexagnet/example', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_ACTOR: 'phungtienviet14-sketch', GITHUB_REF: 'refs/heads/main', ...env },
        encoding: 'utf8',
      }).status === 0;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  assert.equal(run({}), true);
  assert.equal(run({ GITHUB_REPOSITORY: 'nexagnet/.github' }), false);
  assert.equal(run({ GITHUB_EVENT_NAME: 'issue_comment' }), false);
  assert.equal(run({ GITHUB_EVENT_NAME: 'pull_request' }), false);
  assert.equal(run({ GITHUB_ACTOR: 'someone-else' }), false);
  assert.equal(run({ GITHUB_REF: 'refs/heads/feature' }), false);
  assert.equal(run({ GITHUB_REPOSITORY_OWNER: 'other' }), false);
});

// ---------------------------------------------------------------- executable machinery

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'probe-world-'));
  const env = { ...process.env, RUNNER_TEMP: join(dir, 'tmp'), HOME: join(dir, 'home'), GITHUB_ENV: join(dir, 'github_env'),
    GITHUB_STEP_SUMMARY: join(dir, 'summary'), GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'a'.repeat(40) };
  mkdirSync(env.RUNNER_TEMP);
  mkdirSync(env.HOME);
  writeFileSync(env.GITHUB_ENV, '');
  writeFileSync(env.GITHUB_STEP_SUMMARY, '');
  const r = spawnSync('bash', ['-c', setup], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const probe = join(env.RUNNER_TEMP, 'probe');
  const canaries = Object.fromEntries(readFileSync(env.GITHUB_ENV, 'utf8').trim().split('\n').map((l) => l.split('=')));
  return {
    dir, env, probe, canaries, setupOut: r.stdout,
    cleanup: () => {
      try { process.kill(Number(readFileSync(join(probe, 'private/listener.pid'), 'utf8'))); } catch { /* already gone */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('setup: canaries are random+masked and never printed; fixtures and listener are in place', () => {
  const w = world();
  try {
    assert.match(w.setupOut, /::add-mask::[0-9a-f]{32}/);
    assert.equal(w.setupOut.replace(/::add-mask::[0-9a-f]{32}/g, '').includes(w.canaries.NEXAGNET_PROBE_CANARY_DENIED), false, 'value never echoed outside add-mask');
    assert.match(w.canaries.NEXAGNET_PROBE_CANARY_DENIED, /^[0-9a-f]{32}$/);
    assert.notEqual(w.canaries.NEXAGNET_PROBE_CANARY_DENIED, w.canaries.NEXAGNET_PROBE_CANARY_CONTROL);
    assert.ok(existsSync(join(w.env.HOME, '.aws/nexagnet-probe-fixture')));
    assert.ok(Number(readFileSync(join(w.probe, 'private/control_count'), 'utf8')) >= 1, 'host-side positive control connection accepted');
    const probeSrc = readFileSync(join(w.probe, 'public/probe.sh'), 'utf8');
    assert.doesNotMatch(probeSrc, /printenv|\/proc\/self\/environ|^\s*env\b/m, 'probe never dumps the environment');
    assert.equal(spawnSync('bash', ['-n', join(w.probe, 'public/probe.sh')]).status, 0);
    assert.equal(spawnSync('bash', ['-n', join(w.probe, 'private/hook.sh')]).status, 0);
  } finally { w.cleanup(); }
});

test('probe SENSITIVITY: run unsandboxed it reports the leaks, so a PROVEN verdict cannot come from a vacuous probe', () => {
  const w = world();
  try {
    const r = spawnSync('bash', [join(w.probe, 'public/probe.sh')], {
      env: { ...w.env, ...w.canaries, GITHUB_TOKEN: 'synthetic-not-real' }, encoding: 'utf8' });
    const out = r.stdout;
    assert.match(out, /^PROBE_READ_CONTROL=PRESENT$/m);
    assert.match(out, /^PROBE_FS_DENIED_FIXTURE=READABLE$/m, 'would detect a readable denied path');
    assert.match(out, /^PROBE_ENV_NEXAGNET_PROBE_CANARY_DENIED=PRESENT$/m, 'would detect a visible canary');
    assert.match(out, /^PROBE_ENV_GITHUB_TOKEN=PRESENT$/m);
    assert.match(out, /^PROBE_NET_LOOPBACK=REACHED$/m, 'would detect a reachable host listener');
    assert.match(out, /^PROBE_DONE=1$/m);
    assert.equal(out.includes(w.canaries.NEXAGNET_PROBE_CANARY_DENIED), false, 'value is never printed');
    assert.equal(out.includes('PROBE_DENIED_FIXTURE_CONTENT_NOT_A_SECRET'), false, 'fixture content is never printed');
    const accepts = readFileSync(join(w.probe, 'private/listener.log'), 'utf8').split('\n').filter((l) => l === 'accept').length;
    assert.ok(accepts > Number(readFileSync(join(w.probe, 'private/control_count'), 'utf8')), 'host listener independently saw the unsandboxed connection');
  } finally { w.cleanup(); }
});

const expectedSha = (w) => readFileSync(join(w.probe, 'private/expected_cmd_sha'), 'utf8').trim();
const GOOD_MARKERS = ['PROBE_READ_CONTROL=PRESENT', 'PROBE_FS_DENIED_FIXTURE=DENIED', 'PROBE_ENV_NEXAGNET_PROBE_CANARY_DENIED=ABSENT',
  'PROBE_ENV_NEXAGNET_PROBE_CANARY_CONTROL=PRESENT', 'PROBE_ENV_GITHUB_TOKEN=ABSENT', 'PROBE_ENV_GH_TOKEN=ABSENT',
  'PROBE_ENV_CLAUDE_CODE_OAUTH_TOKEN=ABSENT', 'PROBE_ENV_BUILDER_PUBLISHER_APP_PRIVATE_KEY=ABSENT',
  'PROBE_NET_LOOPBACK=DENIED', 'PROBE_NET_CURL=DENIED', 'PROBE_NET_ONLY_LO=TRUE', 'PROBE_DONE=1'];
const rec = (event, sha, markers = [], over = {}) => ({ event, cmd_sha: sha, markers, hook_env_canary_visible: true, leak_canary_value: false, leak_fixture_content: false, ...over });
const goodRecords = (w, markers = GOOD_MARKERS, over = {}) => [rec('PreToolUse', expectedSha(w)), rec('PostToolUse', expectedSha(w), markers, over)];
const swap = (markers, key, value) => markers.map((m) => (m.startsWith(key + '=') ? `${key}=${value}` : m));

function verdict(w, { records, extraAccepts = 0, mutate } = {}) {
  const priv = join(w.probe, 'private');
  const list = records ?? goodRecords(w);
  writeFileSync(join(priv, 'audit.jsonl'), list.map((r) => JSON.stringify(r)).join('\n') + (list.length ? '\n' : ''));
  const control = Number(readFileSync(join(priv, 'control_count'), 'utf8'));
  writeFileSync(join(priv, 'listener.log'), 'accept\n'.repeat(control + extraAccepts));
  if (mutate) mutate(priv);
  writeFileSync(w.env.GITHUB_STEP_SUMMARY, '');
  const r = spawnSync('bash', ['-c', decide], { env: w.env, encoding: 'utf8' });
  const m = r.stdout.match(/SANDBOX_PROBE_VERDICT=(\w+)/);
  return { verdict: m?.[1], ok: r.status === 0, out: r.stdout + r.stderr };
}

test('verdict: PROVEN only when every control and every denial holds; exit code follows', () => {
  const w = world();
  try {
    const good = verdict(w);
    assert.equal(good.verdict, 'SANDBOX_NEGATIVE_PROVEN', good.out);
    assert.equal(good.ok, true);
  } finally { w.cleanup(); }
});

test('verdict: any real leak is SANDBOX_NEGATIVE_FAIL (never PROVEN)', () => {
  const w = world();
  try {
    const leaks = {
      PROBE_FS_DENIED_FIXTURE: 'READABLE', PROBE_ENV_NEXAGNET_PROBE_CANARY_DENIED: 'PRESENT', PROBE_ENV_GITHUB_TOKEN: 'PRESENT',
      PROBE_ENV_CLAUDE_CODE_OAUTH_TOKEN: 'PRESENT', PROBE_NET_LOOPBACK: 'REACHED', PROBE_NET_CURL: 'REACHED', PROBE_NET_ONLY_LO: 'FALSE',
    };
    for (const [key, value] of Object.entries(leaks)) {
      const r = verdict(w, { records: goodRecords(w, swap(GOOD_MARKERS, key, value)) });
      assert.equal(r.verdict, 'SANDBOX_NEGATIVE_FAIL', key + r.out);
      assert.equal(r.ok, false, key);
    }
    for (const flag of ['leak_canary_value', 'leak_fixture_content']) {
      const r = verdict(w, { records: goodRecords(w, GOOD_MARKERS, { [flag]: true }) });
      assert.equal(r.verdict, 'SANDBOX_NEGATIVE_FAIL', flag);
    }
    const extra = verdict(w, { extraAccepts: 1 });
    assert.equal(extra.verdict, 'SANDBOX_NEGATIVE_FAIL', 'host listener saw a sandbox connection');
    assert.match(extra.out, /HOST_LISTENER_ACCEPTED_SANDBOX_CONNECTION/);
  } finally { w.cleanup(); }
});

test('verdict: missing/forged/ambiguous evidence is NOT_PROVEN (fail closed, never PROVEN)', () => {
  const w = world();
  try {
    const sha = expectedSha(w);
    const notProven = (label, opts) => {
      const r = verdict(w, opts);
      assert.equal(r.verdict, 'NOT_PROVEN', label + '\n' + r.out);
      assert.equal(r.ok, false, label);
    };
    notProven('no audit', { records: [] });
    notProven('model ran a different command', { records: [rec('PreToolUse', 'f'.repeat(64)), rec('PostToolUse', 'f'.repeat(64), GOOD_MARKERS)] });
    notProven('extra Bash call', { records: [...goodRecords(w), ...goodRecords(w)] });
    notProven('command never completed (no post)', { records: [rec('PreToolUse', sha)] });
    notProven('failure event without markers', { records: [rec('PreToolUse', sha), rec('PostToolUseFailure', sha, [])] });
    for (const dropped of ['PROBE_DONE', 'PROBE_READ_CONTROL', 'PROBE_ENV_NEXAGNET_PROBE_CANARY_CONTROL', 'PROBE_FS_DENIED_FIXTURE', 'PROBE_ENV_NEXAGNET_PROBE_CANARY_DENIED', 'PROBE_NET_LOOPBACK', 'PROBE_NET_CURL', 'PROBE_NET_ONLY_LO']) {
      notProven('missing ' + dropped, { records: goodRecords(w, GOOD_MARKERS.filter((m) => !m.startsWith(dropped + '='))) });
    }
    notProven('control canary ABSENT (cannot tell deny from scrub)', { records: goodRecords(w, swap(GOOD_MARKERS, 'PROBE_ENV_NEXAGNET_PROBE_CANARY_CONTROL', 'ABSENT')) });
    notProven('read control ABSENT', { records: goodRecords(w, swap(GOOD_MARKERS, 'PROBE_READ_CONTROL', 'ABSENT')) });
    notProven('hook cannot see canary values', { records: goodRecords(w, GOOD_MARKERS, { hook_env_canary_visible: false }) });
    notProven('garbage audit', { mutate: (priv) => writeFileSync(join(priv, 'audit.jsonl'), '{not json') });
  } finally { w.cleanup(); }
  // Without the host-side control connection the listener log cannot be attributed: NOT_PROVEN, never FAIL/PROVEN.
  const w2 = world();
  try {
    const r = verdict(w2, { extraAccepts: 1, mutate: (priv) => rmSync(join(priv, 'control_count')) });
    assert.equal(r.verdict, 'NOT_PROVEN', r.out);
    assert.match(r.out, /LISTENER_CONTROL_MISSING/);
  } finally { w2.cleanup(); }
});

test('hook: records hash + markers + booleans, never values; ignores non-Bash; tolerant of failure shape', () => {
  const w = world();
  try {
    const hook = join(w.probe, 'private/hook.sh');
    const audit = join(w.probe, 'private/audit.jsonl');
    const run = (payload, env = {}) => spawnSync('bash', [hook], { input: JSON.stringify(payload), env: { ...process.env, ...w.canaries, ...env }, encoding: 'utf8' });
    const cmd = `bash ${w.probe}/public/probe.sh`;
    const base = { tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: 't1' };
    assert.equal(run({ ...base, hook_event_name: 'PreToolUse' }).status, 0);
    assert.equal(run({ ...base, hook_event_name: 'PostToolUse', tool_response: { stdout: 'noise\nPROBE_NET_LOOPBACK=DENIED\nrandom line\nPROBE_DONE=1\n', stderr: '' } }).status, 0);
    assert.equal(run({ ...base, hook_event_name: 'PostToolUseFailure', error: 'Exit code 1\nPROBE_DONE=1' }).status, 0);
    assert.equal(run({ tool_name: 'Write', hook_event_name: 'PostToolUse', tool_input: {}, tool_response: {} }).status, 0);
    const lines = readFileSync(audit, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 3, 'non-Bash ignored');
    assert.equal(lines[0].cmd_sha, createHash('sha256').update(cmd).digest('hex'));
    assert.equal(lines[0].cmd_sha, expectedSha(w));
    assert.deepEqual(lines[1].markers, ['PROBE_NET_LOOPBACK=DENIED', 'PROBE_DONE=1']);
    assert.deepEqual(lines[2].markers, ['PROBE_DONE=1']);
    assert.ok(lines.every((l) => l.hook_env_canary_visible === true && l.leak_canary_value === false && l.leak_fixture_content === false));
    // leak detection: canary VALUE or fixture CONTENT anywhere in tool I/O sets a flag
    run({ ...base, hook_event_name: 'PostToolUse', tool_response: { stdout: `x ${w.canaries.NEXAGNET_PROBE_CANARY_DENIED} y` } });
    run({ ...base, hook_event_name: 'PostToolUse', tool_response: { stdout: 'PROBE_DENIED_FIXTURE_CONTENT_NOT_A_SECRET' } });
    // a hook whose env lacks the canaries (e.g. scrubbed) must say so rather than silently pass
    run({ ...base, hook_event_name: 'PostToolUse', tool_response: { stdout: '' } }, { NEXAGNET_PROBE_CANARY_DENIED: '', NEXAGNET_PROBE_CANARY_CONTROL: '' });
    const all = readFileSync(audit, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(all[3].leak_canary_value, true);
    assert.equal(all[4].leak_fixture_content, true);
    assert.equal(all[5].hook_env_canary_visible, false);
    const raw = readFileSync(audit, 'utf8');
    assert.equal(raw.includes(w.canaries.NEXAGNET_PROBE_CANARY_DENIED), false, 'audit never stores the canary value');
    assert.equal(raw.includes('PROBE_DENIED_FIXTURE_CONTENT_NOT_A_SECRET'), false, 'audit never stores fixture content');
  } finally { w.cleanup(); }
});
