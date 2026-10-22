'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const workflowPath = resolve(__dirname, '../.github/workflows/claude-read-isolation-probe.yml');
const python = process.env.NEXAGNET_TEST_PYTHON || (process.platform === 'win32'
  ? 'C:/Users/phung/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
  : 'python3');
const source = () => readFileSync(workflowPath, 'utf8').replaceAll('\r\n', '\n');
function verifier() {
  const block = source().split('          # READ_VERIFY_PY_BEGIN\n')[1]?.split('          # READ_VERIFY_PY_END')[0];
  assert.ok(block, 'verifier must be the actual embedded trusted code');
  return block.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
}
function fixture() {
  const cases = ['Read', 'Glob', 'Grep'].flatMap(tool => [
    { id: `${tool}-control`, tool, kind: 'control', input: { path: '/fake/public/control.txt' } },
    ...['home', 'absolute', 'symlink', 'normalized'].map(alias => ({
      id: `${tool}-${alias}`, tool, kind: 'denied', input: { path: `/fake/.aws/${alias}/denied.txt` },
    })),
  ]);
  const manifest = { cases, control_value: 'SYNTHETIC_CONTROL', denied_value: 'SYNTHETIC_DENIED' };
  const calls = cases.map((item, i) => ({ type: 'tool_use', id: `call-${i}`, name: item.tool, input: item.input }));
  const results = cases.filter(item => item.kind === 'control').map(item => ({
    type: 'tool_result', tool_use_id: calls[cases.indexOf(item)].id,
    content: item.tool === 'Glob' ? '/fake/public/control.txt' : manifest.control_value,
  }));
  const denials = cases.filter(item => item.kind === 'denied').map(item => ({
    tool_name: item.tool, tool_use_id: calls[cases.indexOf(item)].id, tool_input: item.input,
  }));
  return { manifest, messages: [
    { type: 'assistant', message: { content: calls } },
    { type: 'user', message: { content: results } },
    { type: 'result', subtype: 'success', is_error: false, permission_denials: denials },
  ], fixture_ok: true, cli_version: '2.1.293' };
}
function evaluate(value) {
  assert.ok(existsSync(python) || process.platform !== 'win32', 'Python test runtime unavailable');
  const code = Buffer.from(verifier()).toString('base64');
  const run = spawnSync(python, ['-c',
    'import base64,json,sys; scope={"__name__":"probe_test"}; exec(base64.b64decode(sys.argv[1]),scope); p=json.load(sys.stdin); print(json.dumps(scope["evaluate"](**p)))', code],
  { input: JSON.stringify(value), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr.slice(0, 500));
  return JSON.parse(run.stdout);
}

function guard(manifest, value) {
  const block = source().split('          # READ_GUARD_PY_BEGIN\n')[1]?.split('          # READ_GUARD_PY_END')[0];
  assert.ok(block, 'guard must be the actual embedded trusted code');
  const code = block.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  const run = spawnSync(python, ['-c',
    'import base64,json,sys; scope={"__name__":"probe_test"}; exec(base64.b64decode(sys.argv[1]),scope); p=json.load(sys.stdin); print(json.dumps(scope["guard_decision"](**p)))', Buffer.from(code).toString('base64')],
  { input: JSON.stringify({ manifest, value }), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr.slice(0, 500));
  return JSON.parse(run.stdout);
}

test('safety guard is neutral for every exact planned pair and denies other tool inputs', () => {
  const { manifest } = fixture();
  const event = item => ({ hook_event_name: 'PreToolUse', tool_name: item.tool, tool_input: item.input });
  for (const item of manifest.cases) assert.deepEqual(guard(manifest, event(item)), {});
  const valid = event(manifest.cases[0]);
  for (const value of [null, {}, { ...valid, hook_event_name: 'PostToolUse' },
    { ...valid, tool_name: 'Bash' }, { ...valid, tool_input: { path: '/real/credential' } },
    { ...valid, tool_input: { ...valid.tool_input, extra: true } }]) {
    assert.equal(guard(manifest, value).hookSpecificOutput.permissionDecision, 'deny');
  }
  for (const broken of [{ cases: [] }, { cases: [...manifest.cases, manifest.cases[0]] }, null]) {
    assert.equal(guard(broken, valid).hookSpecificOutput.permissionDecision, 'deny');
  }
  assert.match(source(), /"hooks": \{"PreToolUse"/);
});

test('Read diagnostic is owner/repository/ref/SHA gated with explicit read-only credentials', () => {
  const text = source();
  for (const value of [
    'expected_consumer_sha:', 'phungtienviet14-sketch', 'nexagnet/legal-office',
    'refs/heads/codex/tool-isolation-runtime-36-37', 'test "$GITHUB_SHA" = "$EXPECTED_SHA"',
    'show_full_output: \'false\'', '--setting-sources user', '--strict-mcp-config',
    '--mcp-config \'{"mcpServers":{}}\'', 'Read(~/.aws/**)',
    "ENABLE_CLAUDEAI_MCP_SERVERS: 'false'", 'Read(/${{ github.workspace }}/.git/**)',
  ]) assert.ok(text.includes(value), value);
  assert.doesNotMatch(text, /secrets:\s*inherit|contents: write|issues: write|pull-requests: write|id-token: write/);
  assert.doesNotMatch(text, /secrets\.BUILDER_PUBLISHER|allowUnsandboxedCommands": true|--dangerously-skip-permissions/);
  assert.ok(text.includes('steps.claude.outputs.execution_file'));
  assert.ok(text.includes('name: read-isolation-proof'));
  assert.doesNotMatch(text, /path:.*claude-execution-output/);
});

test('all three controls and twelve authoritative native denials prove the scoped matrix', () => {
  const result = evaluate(fixture());
  assert.equal(result.verdict, 'READ_ISOLATION_PROVEN');
  assert.equal(result.cases.length, 15);
});

test('missing or duplicate actual calls cannot prove denial', () => {
  const missing = fixture();
  missing.messages[0].message.content.pop();
  assert.equal(evaluate(missing).verdict, 'NOT_PROVEN');
  const duplicate = fixture();
  duplicate.messages[0].message.content.push({ ...duplicate.messages[0].message.content[0], id: 'duplicate' });
  assert.equal(evaluate(duplicate).verdict, 'NOT_PROVEN');
});

test('a filtered-empty Glob/Grep response without native permission_denials is NOT_PROVEN', () => {
  const value = fixture();
  value.messages[2].permission_denials = value.messages[2].permission_denials.filter(d => d.tool_name === 'Read');
  for (let i = 5; i < 15; i += 1) {
    if (value.manifest.cases[i].kind === 'denied') value.messages[1].message.content.push({
      type: 'tool_result', tool_use_id: `call-${i}`, content: 'No files found',
    });
  }
  assert.equal(evaluate(value).verdict, 'NOT_PROVEN');
});

test('missing positive controls, unknown tools and unsuccessful execution fail closed', () => {
  const control = fixture();
  control.messages[1].message.content[0].content = '';
  assert.equal(evaluate(control).verdict, 'NOT_PROVEN');
  const unexpected = fixture();
  unexpected.messages[0].message.content.push({ type: 'tool_use', id: 'other', name: 'Bash', input: {} });
  assert.equal(evaluate(unexpected).verdict, 'NOT_PROVEN');
  const failed = fixture();
  failed.messages[2].is_error = true;
  assert.equal(evaluate(failed).verdict, 'NOT_PROVEN');
});

test('denied synthetic content exposure is FAIL even if a denial was also reported', () => {
  const value = fixture();
  value.messages[1].message.content.push({ type: 'tool_result', tool_use_id: 'call-1', content: value.manifest.denied_value });
  assert.equal(evaluate(value).verdict, 'READ_ISOLATION_FAIL');
});

test('unknown CLI, broken fixture controls and mismatched denial identity cannot prove', () => {
  assert.equal(evaluate({ ...fixture(), cli_version: 'unknown' }).verdict, 'NOT_PROVEN');
  assert.equal(evaluate({ ...fixture(), fixture_ok: false }).verdict, 'NOT_PROVEN');
  const mismatch = fixture();
  mismatch.messages[2].permission_denials[0].tool_input = { path: '/different' };
  assert.equal(evaluate(mismatch).verdict, 'NOT_PROVEN');
});

test('empty matrix and conflicting or duplicate result evidence cannot produce PROVEN', () => {
  const empty = fixture();
  empty.manifest.cases = [];
  empty.messages[0].message.content = [];
  empty.messages[1].message.content = [];
  empty.messages[2].permission_denials = [];
  assert.equal(evaluate(empty).verdict, 'NOT_PROVEN');
  const conflict = fixture();
  conflict.messages[1].message.content.push({ type: 'tool_result', tool_use_id: 'call-1', content: '' });
  assert.equal(evaluate(conflict).verdict, 'NOT_PROVEN');
  const duplicate = fixture();
  duplicate.messages[1].message.content.push(
    { type: 'tool_result', tool_use_id: 'call-6', is_error: true, content: '' },
    { type: 'tool_result', tool_use_id: 'call-6', content: '/fake/.aws/home/denied.txt' },
  );
  assert.equal(evaluate(duplicate).verdict, 'READ_ISOLATION_FAIL');
});
