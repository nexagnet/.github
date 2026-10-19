'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const path = resolve(__dirname, '../.github/workflows/claude-builder.yml');
const source = readFileSync(path, 'utf8');
// Ruby Psych ships on Ubuntu 24.04; parsing first ensures YAML syntax is valid.
const data = JSON.parse(execFileSync(
  'ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.load_file(ARGV[0]))', path],
  { encoding: 'utf8' }
));
const caller = (data.on || data.true).workflow_call;
const jobs = data.jobs;
const preflight = jobs.preflight.steps.find(s => s.id === 'gate').run;
const agent = jobs.agent;
const publish = jobs.publish;
const validator = publish.steps.find(s => s.name?.startsWith('Validate patch')).run;

test('reusable workflow, restricted author and pinned dependencies', () => {
  assert.ok(caller);
  assert.equal(caller.inputs.issue_number.type, 'number');
  assert.equal(caller.secrets.CLAUDE_CODE_OAUTH_TOKEN.required, true);
  assert.equal(caller.secrets.BUILDER_PUBLISHER_APP_ID.required, true);
  assert.equal(caller.secrets.BUILDER_PUBLISHER_APP_PRIVATE_KEY.required, true);
  assert.match(preflight, /GITHUB_ACTOR.*phungtienviet14-sketch/);
  const matches = [...source.matchAll(/uses:\s*[\w.-]+\/[\w.-]+@([0-9a-f]{40})/g)];
  assert.ok(matches.length >= 4, 'Actions must be pinned to full commit SHA');
  assert.equal(source.includes('secrets: inherit'), false);
});

test('AI job has no GitHub write permission, OIDC or publisher credential', () => {
  assert.equal(agent.permissions.contents, 'read');
  assert.equal(agent.permissions.issues, 'read');
  assert.equal(agent.permissions['pull-requests'], 'read');
  assert.equal(agent.permissions['id-token'], undefined);
  assert.ok(!JSON.stringify(agent).includes('secrets.BUILDER_PUBLISHER_APP_PRIVATE_KEY'));
  // Naming a credential in sandbox deny rules does not expose its secret value.
  const step = agent.steps.find(s => s.name?.startsWith('Claude proposes'));
  assert.equal(step.with.github_token, '\${{ github.token }}');
  assert.match(step.with.claude_args, /--allowedTools "Read,Glob,Grep,Edit,Write,Bash"/);
  assert.match(step.with.claude_args, /--disallowedTools "WebFetch,WebSearch"/);
  assert.doesNotMatch(step.with.claude_args, /--dangerously-skip-permissions/);
});

test('Claude receives the frozen canonical Task Contract only after ready gate', () => {
  assert.match(preflight, /autopilot:ready/);
  assert.match(preflight, /contract_b64=.*base64/);
  const mount = agent.steps.find(s => s.name?.startsWith('Mount frozen Task Contract'));
  assert.ok(mount);
  assert.match(mount.run, /base64 -d/);
  const step = agent.steps.find(s => s.name?.startsWith('Claude proposes'));
  assert.match(step.with.prompt, /task-contract\.md/);
  assert.match(validator, /Issue readiness revoked/);
});

test('privileged publisher is strictly downstream from validation', () => {
  assert.deepEqual(publish.needs, ['preflight', 'agent']);
  assert.equal(publish.permissions.contents, 'read');
  const validatorIdx = publish.steps.findIndex(s => s.name?.startsWith('Validate patch'));
  const tokenIdx = publish.steps.findIndex(s => s.id === 'publisher');
  assert.ok(validatorIdx >= 0 && tokenIdx > validatorIdx);
  assert.equal(publish.steps[tokenIdx].with['permission-contents'], 'write');
  assert.equal(publish.steps[tokenIdx].with['permission-pull-requests'], 'write');
  assert.equal(publish.steps[tokenIdx].with['permission-workflows'], undefined);
  assert.match(validator, /git apply --check --index/);
  assert.match(validator, /Base HEAD changed/);
  assert.match(validator, /risk:\$EXPECTED_RISK/);
  assert.match(publish.steps.find(s => s.id === 'draft').run, /-F draft=true/);
});

function extractCase(source, variable) {
  const start = source.indexOf('case "$' + variable + '" in');
  assert.ok(start >= 0);
  const end = source.indexOf('esac', start);
  assert.ok(end > start);
  return source.slice(start, end + 4);
}

function testCase(snippet, variable, value) {
  const result = spawnSync('bash', ['-c', 'set -e\n' + variable + '="$1"\n' + snippet, 'test-case', value], { encoding: 'utf8' });
  return result.status === 0;
}

test('all-repositories installation never executes Builder on central control-plane repo', () => {
  assert.match(preflight, /test "\$GITHUB_REPOSITORY" != "nexagnet\/\.github"/);
  assert.match(validator, /test "\$GITHUB_REPOSITORY" != "nexagnet\/\.github"/);
});

test('Task Contract drift is rejected before privileged publisher token', () => {
  assert.match(preflight, /contract_hash=.*sha256sum/);
  assert.match(validator, /current_contract_hash=.*sha256sum/);
  assert.match(validator, /Task Contract changed; rerun preflight/);
  const gate = publish.steps.find(s => s.name?.startsWith('Validate patch'));
  assert.equal(gate.env.EXPECTED_CONTRACT_HASH, '${{ needs.preflight.outputs.contract_hash }}');
});

test('path guard rejects protected paths case-insensitively and accepts normal files', () => {
  const normalizeStart = validator.indexOf('p="$(printf');
  const caseStart = validator.indexOf('case "$p" in', normalizeStart);
  assert.ok(normalizeStart >= 0 && caseStart > normalizeStart);
  const caseEnd = validator.indexOf('esac', caseStart) + 4;
  const normalizeAndCase = validator.slice(normalizeStart, caseEnd);
  for (const blocked of [
    '.github/workflows/ci.yml', '.GitHub/workflows/x.yml',
    'nested/.github/evil.yml', 'infra/secret', 'deploy/run.sh',
    'tools/autopilot/preflight.mjs', '.claude/settings.json',
    'src/AGENTS.md', 'CLAUDE.md', '.mcp.json', '.env', '.env.production', 'src/.env', 'src/.npmrc',
    '.gitmodules', '.gitattributes', 'private.pem'
  ]) {
    assert.equal(testCase(normalizeAndCase, 'path', blocked), false, blocked);
  }
  for (const allowed of ['src/index.ts', 'docs/readme.md', 'tests/app.spec.ts']) {
    assert.equal(testCase(normalizeAndCase, 'path', allowed), true, allowed);
  }
});

test('file mode guard blocks symlink/submodule artifacts', () => {
  const snippet = extractCase(validator, 'mode');
  for (const forbidden of ['120000', '160000']) {
    assert.equal(testCase(snippet, 'mode', forbidden), false, forbidden);
  }
  for (const allowed of ['100644', '100755', '']) {
    assert.equal(testCase(snippet, 'mode', allowed), true, allowed);
  }
});

// Actor/event/risk/contract gates now run against a fake GitHub in
// tests/claude-builder-intent-idempotency.test.cjs (real preflight shell, strict intent, ledger, PR guard).

test('Claude Builder bootstraps bubblewrap before action without disabling env isolation', () => {
  assert.equal(agent.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1');
  const install = agent.steps.find(s => s.name === 'Install bubblewrap for isolated Claude subprocesses');
  const claude = agent.steps.find(s => s.name?.startsWith('Claude proposes LOCAL'));
  assert.ok(install && claude, 'install and Claude steps must exist');
  assert.ok(agent.steps.indexOf(install) < agent.steps.indexOf(claude));
  assert.match(install.run, /set -euo pipefail/);
  assert.match(install.run, /sudo apt-get install -y --no-install-recommends bubblewrap/);
  assert.match(install.run, /command -v bwrap/);
  assert.match(install.run, /bwrap --version/);
  assert.ok(!/CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0/.test(source));
  assert.equal(install.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test('Central control-plane CI verifies the real PR HEAD or pushed main commit', () => {
  const ci = readFileSync(resolve(__dirname, '../.github/workflows/controlplane-ci.yml'), 'utf8');
  assert.ok(ci.includes('EXPECTED_SHA: ${{ github.event.pull_request.head.sha || github.sha }}'));
  assert.ok(ci.includes('ref: ${{ env.EXPECTED_SHA }}'));
  assert.ok(ci.includes('persist-credentials: false'));
  assert.ok(ci.includes('actual="$(git rev-parse HEAD)"'));
  assert.ok(ci.includes('test "${actual}" = "${EXPECTED_SHA}"'));
  assert.ok(ci.includes('expected=${EXPECTED_SHA} actual=${actual}'));
  assert.ok(ci.includes('go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7'));
  assert.ok(ci.includes('node --test tests/claude-builder-contract.test.cjs tests/claude-reviewer-contract.test.cjs'));
});


test('strict sandbox is mandatory before enabling Bash and all credential escapes are blocked', () => {
  const claude = agent.steps.find(s => s.name?.startsWith('Claude proposes'));
  const settings = JSON.parse(claude.with.settings);
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.failIfUnavailable, true);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.equal(settings.sandbox.autoAllowBashIfSandboxed, true);
  assert.deepEqual(settings.sandbox.network.allowedDomains, []);
  assert.equal(settings.sandbox.filesystem.disabled, undefined);
  assert.ok(settings.sandbox.filesystem.denyRead.includes('~/.claude'));
  assert.ok(settings.sandbox.filesystem.denyRead.includes('/proc/self/environ'));
  assert.ok(settings.sandbox.filesystem.denyRead.includes('/proc/*/environ'));
  for (const name of ['Read(//proc/**)', 'Read(~/.claude/**)', 'Read(~/.config/gh/**)']) {
    assert.ok(settings.permissions.deny.includes(name), name);
  }
  for (const target of ['.github','infra','deploy','tools/autopilot']) {
    assert.ok(settings.sandbox.filesystem.denyWrite.some(p => p.endsWith('/' + target)), target);
  }
  for (const secret of ['GITHUB_TOKEN','GH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','BUILDER_PUBLISHER_APP_PRIVATE_KEY']) {
    assert.ok(settings.sandbox.credentials.envVars.some(x => x.name === secret && x.mode === 'deny'), secret);
  }
  assert.equal(agent.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1');
  assert.equal(settings.permissions.deny.includes('Bash'), false);
  assert.ok(settings.permissions.deny.includes('WebFetch'));
  assert.ok(settings.permissions.deny.includes('WebSearch'));
  assert.match(claude.with.prompt, /NO unsandboxed retry/);
  assert.match(claude.with.claude_args, /--max-turns 80/);
  assert.equal(claude.with.show_full_output, 'false');
});

test('Builder installs test dependencies without running untrusted lifecycle scripts, before Claude', () => {
  const claude = agent.steps.find(s => s.name?.startsWith('Claude proposes'));
  const prepare = agent.steps.find(s => s.name?.startsWith('Prepare pnpm offline'));
  const node = agent.steps.filter(s => s.name?.startsWith('Set up Node'));
  const install = agent.steps.find(s => s.name === 'Install bubblewrap for isolated Claude subprocesses');
  assert.equal(node.length, 2);
  assert.ok(prepare && install);
  assert.ok(agent.steps.indexOf(prepare) < agent.steps.indexOf(claude));
  assert.ok(agent.steps.indexOf(install) < agent.steps.indexOf(claude));
  assert.match(prepare.run, /pnpm install --frozen-lockfile --ignore-scripts/);
  assert.match(install.run, /bubblewrap socat/);
  assert.match(install.run, /command -v socat/);
  assert.equal(prepare.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(prepare.env?.BUILDER_PUBLISHER_APP_PRIVATE_KEY, undefined);
  assert.equal(agent.permissions['id-token'], undefined);
  assert.equal(publish.needs.includes('agent'), true);
});


test('Agent failing to produce a patch reports fail-closed classification', () => {
  const diagnostic = agent.steps.find(s => s.name?.startsWith('Agent failure classification'));
  const patch = agent.steps.find(s => s.name?.startsWith('Produce UNTRUSTED patch'));
  assert.ok(diagnostic && patch);
  assert.equal(diagnostic.if, 'failure()');
  assert.match(diagnostic.run, /BUILDER_AGENT_FAILED/);
  assert.match(patch.run, /NO_PATCH/);
  assert.match(patch.run, /git diff --cached --quiet/);
  assert.ok(agent.steps.indexOf(diagnostic) < agent.steps.indexOf(patch));
});


test('Builder emits bounded structured status instead of silent model success', () => {
  const claude = agent.steps.find(s => s.id === 'claude');
  const status = agent.steps.find(s => s.name?.startsWith('Validate bounded agent status'));
  const patch = agent.steps.find(s => s.name?.startsWith('Produce UNTRUSTED patch'));
  assert.ok(claude && status && patch);
  assert.ok(agent.steps.indexOf(claude) < agent.steps.indexOf(status));
  assert.ok(agent.steps.indexOf(status) < agent.steps.indexOf(patch));
  const match = claude.with.claude_args.match(/--json-schema '([^']+)'/);
  assert.ok(match, 'agent must return structured diagnostic schema');
  const schema = JSON.parse(match[1]);
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.status.enum, ['APPLIED', 'BLOCKED']);
  assert.ok(schema.properties.blocker_code.enum.includes('SANDBOX_UNAVAILABLE'));
  assert.ok(schema.properties.blocker_code.enum.includes('UNREADABLE_CONTRACT'));
  assert.equal(schema.properties.summary.maxLength, 500);
  assert.equal(schema.properties.local_checks_attempted.type, 'boolean');
  assert.equal(status.env.STRUCTURED, '$' + '{{ steps.claude.outputs.structured_output }}');
  assert.match(claude.with.prompt, /do not forbid preparing local/);
  assert.match(claude.with.prompt, /do not invent file changes/);
  assert.match(status.run, /BUILDER_STATUS_MISSING/);
  assert.match(status.run, /BUILDER_BLOCKED/);
  assert.doesNotMatch(status.run, /jq -r .summary|echo "\$STRUCTURED"|cat.*claude-execution/);
  assert.match(patch.run, /git diff --cached --quiet/);
  assert.equal(claude.with.show_full_output, 'false');
});

test('structured status validator fails closed on missing, malformed, inconsistent or blocked response', () => {
  const step = agent.steps.find(s => s.name?.startsWith('Validate bounded agent status'));
  const folder = mkdtempSync(join(tmpdir(), 'nexagnet-v5-status-'));
  try {
    const summary = join(folder, 'summary');
    function check(value) {
      writeFileSync(summary, '');
      const obj = typeof value === 'string' ? value : JSON.stringify(value);
      return spawnSync('bash', ['-c', step.run], {
        env: { ...process.env, STRUCTURED: obj, GITHUB_STEP_SUMMARY: summary },
        encoding: 'utf8',
      }).status === 0;
    }
    const applied = {status:'APPLIED',blocker_code:'NONE',summary:'Changed docs',local_checks_attempted:true};
    assert.equal(check(applied), true);
    assert.equal(check({...applied,status:'BLOCKED'}), false);
    assert.equal(check({...applied,status:'BLOCKED',blocker_code:'SANDBOX_UNAVAILABLE'}), false);
    assert.equal(check({...applied,blocker_code:'NETWORK_REQUIRED'}), false);
    assert.equal(check({...applied,summary:'x'.repeat(501)}), false);
    assert.equal(check({...applied,local_checks_attempted:'true'}), false);
    assert.equal(check(''), false);
    assert.equal(check('{bad'), false);
    assert.equal(check({status:'APPLIED'}), false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});


test('Builder runner must prove strict isolated network namespace before Claude (R3 #29)', () => {
  assert.equal(agent['runs-on'], 'ubuntu-22.04', 'use only proven compatible hosted runner');
  const install = agent.steps.find(s => s.name === 'Install bubblewrap for isolated Claude subprocesses');
  const probe = agent.steps.find(s => s.name === 'Verify strict bwrap network sandbox before Claude');
  const claude = agent.steps.find(s => s.id === 'claude');
  const publishToken = publish.steps.find(s => s.name === 'Mint restricted publisher token after PASS');
  assert.ok(install && probe && claude && publishToken);
  assert.ok(agent.steps.indexOf(install) < agent.steps.indexOf(probe));
  assert.ok(agent.steps.indexOf(probe) < agent.steps.indexOf(claude));
  for(const expected of [
    'set -euo pipefail',
    'timeout 15s bwrap',
    '--unshare-user --unshare-net',
    'test "$sandbox_net" != "$HOST_NET"',
    'grep -q "lo:" /proc/net/dev',
    'BWRAP_SANDBOX_NAMESPACE_READY'
  ]) assert.ok(probe.run.includes(expected), expected);
  assert.doesNotMatch(probe.run, /sysctl\s+-w|--share-net|sudo|allowUnsandboxedCommands|--cap-add/);
  assert.equal(probe.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(probe.env?.BUILDER_PUBLISHER_APP_PRIVATE_KEY, undefined);
  assert.equal(agent.permissions.contents, 'read');
  assert.equal(agent.permissions['pull-requests'], 'read');
  assert.ok(!JSON.stringify(agent).includes('secrets.BUILDER_PUBLISHER_APP_PRIVATE_KEY'));
  const settings = JSON.parse(claude.with.settings);
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.failIfUnavailable, true);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(settings.sandbox.network.allowedDomains, []);
});
