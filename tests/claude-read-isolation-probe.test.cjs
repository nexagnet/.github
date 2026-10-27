'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

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
  cases.push(
    { id: 'Read-control-home', tool: 'Read', kind: 'control', input: { file_path: '~/public/control-home.txt' } },
    { id: 'Read-control-normalized', tool: 'Read', kind: 'control', input: { file_path: '/fake/public/step/../control-normalized.txt' } },
  );
  const manifest = { cases, control_value: 'SYNTHETIC_CONTROL', denied_value: 'SYNTHETIC_DENIED' };
  const calls = cases.map((item, i) => ({ type: 'tool_use', id: `call-${i}`, name: item.tool, input: item.input }));
  const results = cases.filter(item => item.kind === 'control').map(item => ({
    type: 'tool_result', tool_use_id: calls[cases.indexOf(item)].id,
    content: item.tool === 'Glob' ? '/fake/public/control.txt' : manifest.control_value,
  }));
  const denials = cases.filter(item => item.kind === 'denied').map(item => ({
    tool_name: item.tool, tool_use_id: calls[cases.indexOf(item)].id, tool_input: item.input,
  }));
  results.push(...denials.map(denial => ({ type: 'tool_result', tool_use_id: denial.tool_use_id,
    is_error: true, content: 'Synthetic native permission denial' })));
  const guard_events = calls.map((call, index) => ({
    schema: 'read-guard-audit-v1', id_sha256: createHash('sha256').update(call.id).digest('hex'),
    tool: call.name, decision: 'neutral', case_index: index, expanded_case_index: index,
    has_tilde: false, has_dotdot: false,
  }));
  return { manifest, guard_events, messages: [
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

function guardProcesses(manifest, events, brokenAudit = false, postWriteFailure = false) {
  const block = source().split('          # READ_GUARD_PY_BEGIN\n')[1]?.split('          # READ_GUARD_PY_END')[0];
  const code = block.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  const script = `import base64,json,sys,tempfile,pathlib,os,subprocess,concurrent.futures
p=json.load(sys.stdin)
with tempfile.TemporaryDirectory() as folder:
 private=pathlib.Path(folder)/'read-probe/private'; private.mkdir(parents=True)
 (private/'manifest.json').write_text(json.dumps(p['manifest']))
 audit=private/'guard-audit.jsonl'
 if p['broken']: audit.mkdir()
 else: audit.touch(mode=0o600)
 code=base64.b64decode(sys.argv[1]).decode()
 if p['post_write']:
  code=code.replace('    main()', '    original_close = os.close\\n    def failing_close(descriptor):\\n        original_close(descriptor)\\n        raise OSError("synthetic post-write close failure")\\n    os.close = failing_close\\n    main()')
 guard=private/'guard.py'; guard.write_text(code)
 env=dict(os.environ,RUNNER_TEMP=folder)
 def invoke(event):
  run=subprocess.run([sys.executable,str(guard)],input=json.dumps(event),capture_output=True,text=True,env=env)
  if run.returncode: raise RuntimeError('guard process failed')
  return json.loads(run.stdout)
 with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool: decisions=list(pool.map(invoke,p['events']))
 records=[json.loads(line) for line in audit.read_text().splitlines()] if audit.is_file() else []
 print(json.dumps({'decisions':decisions,'records':records,'mode':audit.stat().st_mode & 0o777}))
`;
  const run = spawnSync(python, ['-c', script, Buffer.from(code).toString('base64')], {
    input: JSON.stringify({ manifest, events, broken: brokenAudit, post_write: postWriteFailure }), encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr.slice(0, 500));
  return JSON.parse(run.stdout);
}

function integration(messages, invalidExecution = false, auditEvents = fixture().guard_events) {
  const script = `import base64,json,sys,tempfile,pathlib,os
from unittest.mock import patch
from types import SimpleNamespace
scope={"__name__":"probe_test"}
exec(base64.b64decode(sys.argv[1]),scope)
p=json.load(sys.stdin)
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder); base=root/'read-probe'; home=base/'home'; private=base/'private'
 private.mkdir(parents=True); (home/'public').mkdir(parents=True)
 manifest=p['manifest']; manifest['home']=str(home)
 (home/'public/control.txt').write_text(manifest['control_value'])
 (home/'public/step').mkdir()
 for alias in ['control-home.txt','control-normalized.txt']: (home/'public'/alias).write_text(manifest['control_value'])
 for alias in ['home','absolute','symlink','normalized']:
  target=home/'.aws'/alias; target.mkdir(parents=True); (target/'denied.txt').write_text(manifest['denied_value'])
 (private/'manifest.json').write_text(json.dumps(manifest))
 if p['audit'] is not None:
  (private/'guard-audit.jsonl').write_text(''.join(json.dumps(event)+'\\n' for event in p['audit']))
  (private/'guard-audit.jsonl').chmod(0o600)
 execution=root/'claude-execution-output.json'; execution.write_text('invalid-json' if p['invalid'] else json.dumps(p['messages']))
 env={'RUNNER_TEMP':folder,'EXECUTION_FILE':str(execution),'ACTION_OUTCOME':'success','GITHUB_SHA':'a'*40,'GITHUB_RUN_ID':'123','GITHUB_STEP_SUMMARY':str(root/'summary')}
 original_resolve=pathlib.Path.resolve
 def resolve_alias(path,*args,**kwargs):
  return original_resolve(home/'.aws') if path == home/'public/alias' else original_resolve(path,*args,**kwargs)
 with patch.dict(os.environ,env), patch.object(pathlib.Path,'resolve',resolve_alias), patch.object(scope['subprocess'],'run',return_value=SimpleNamespace(returncode=0,stdout='2.1.293 (Claude Code)')):
  try: scope['main']()
  except SystemExit as error: status=error.code
 proof=json.loads((base/'proof.json').read_text()); print('TEST_PROOF='+json.dumps({'proof':proof,'status':status}))
`;
  const value = fixture();
  const run = spawnSync(python, ['-c', script, Buffer.from(verifier()).toString('base64')],
    { input: JSON.stringify({ manifest: value.manifest, messages, invalid: invalidExecution, audit: auditEvents }), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr.slice(0, 500));
  return JSON.parse(run.stdout.split('TEST_PROOF=')[1]);
}

test('main accepts SDK non-content progress without losing actual native case evidence', () => {
  const messages = [...fixture().messages, { type: 'system', message: 'progress' },
    { type: 'system', message: null }, { type: 'system', message: { content: 'status' } }];
  const result = integration(messages);
  assert.equal(result.status, 0);
  assert.equal(result.proof.verdict, 'READ_ISOLATION_PROVEN');
});

test('main invalid transcript emits bounded stage and class only', () => {
  const result = integration([], true);
  assert.equal(result.status, 1);
  assert.equal(result.proof.verdict, 'NOT_PROVEN');
  assert.equal(result.proof.verifier_stage, 'EXECUTION_PARSE');
  assert.equal(result.proof.verifier_error, 'JSON_INVALID');
  assert.doesNotMatch(JSON.stringify(result.proof), /invalid-json|Traceback|TemporaryDirectory/);
});

test('main rejects malformed or wrong-role tool evidence with safe diagnostics', () => {
  for (const extra of [{ type: 'assistant', message: 'malformed' },
    { type: 'user', message: { content: [fixture().messages[0].message.content[0]] } }]) {
    const result = integration([...fixture().messages, extra]);
    assert.equal(result.status, 1);
    assert.equal(result.proof.verdict, 'NOT_PROVEN');
    assert.equal(result.proof.verifier_stage, 'EVIDENCE_EVALUATE');
    assert.ok(['SHAPE_INVALID', 'VALUE_INVALID'].includes(result.proof.verifier_error));
  }
});

test('safety guard is neutral for every exact planned pair and denies other tool inputs', () => {
  const { manifest } = fixture();
  const event = item => ({ hook_event_name: 'PreToolUse', tool_name: item.tool, tool_input: item.input, tool_use_id: 'guard-test-call' });
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

test('all five controls, neutral guard audit and twelve native denials prove the scoped matrix', () => {
  const result = evaluate(fixture());
  assert.equal(result.verdict, 'READ_ISOLATION_PROVEN');
  assert.equal(result.schema, 'nexagnet-read-isolation-v2');
  assert.equal(result.cases.length, 17);
  assert.ok(result.cases.every(item => item.guard_diag.guard_neutral));
});

test('actual concurrent guard processes append bounded private evidence before neutral decisions', () => {
  const { manifest } = fixture();
  const events = manifest.cases.map((item, i) => ({ hook_event_name: 'PreToolUse',
    tool_name: item.tool, tool_input: item.input, tool_use_id: `guard-${i}` }));
  const result = guardProcesses(manifest, events);
  assert.equal(result.records.length, 17);
  assert.ok(result.decisions.every(decision => Object.keys(decision).length === 0));
  assert.equal(new Set(result.records.map(record => record.id_sha256)).size, 17);
  assert.equal(result.records.find(record => record.case_index === 15).has_tilde, true);
  assert.equal(result.records.find(record => record.case_index === 16).has_dotdot, true);
  for (const record of result.records) {
    assert.match(record.id_sha256, /^[0-9a-f]{64}$/);
    assert.equal(record.decision, 'neutral');
    assert.equal(typeof record.has_tilde, 'boolean');
    assert.ok(Number.isInteger(record.case_index) && record.case_index >= 0 && record.case_index < 17);
  }
  if (process.platform !== 'win32') assert.equal(result.mode, 0o600);
  assert.doesNotMatch(JSON.stringify(result.records), /file_path|tool_input|\/fake\/|guard-0/);
  const broken = guardProcesses(manifest, [events[0]], true);
  assert.equal(broken.decisions[0].hookSpecificOutput.permissionDecision, 'deny');
  const invalid = guardProcesses(manifest, [{ ...events[0], tool_use_id: null }]);
  assert.equal(invalid.decisions[0].hookSpecificOutput.permissionDecision, 'deny');
  const late = guardProcesses(manifest, [events[1]], false, true);
  assert.equal(late.records[0].decision, 'neutral');
  assert.equal(late.decisions[0].hookSpecificOutput.permissionDecision, 'deny');
});

test('explicit guard denial or hook failure cannot be credited as native-policy proof', () => {
  for (const error of ['Outside the synthetic file-tool case matrix or audit unavailable', 'PreToolUse hook error: synthetic timeout']) {
    const value = fixture();
    value.messages[1].message.content.push({ type: 'tool_result', tool_use_id: 'call-1', is_error: true, content: error });
    const result = evaluate(value);
    assert.equal(result.verdict, 'NOT_PROVEN');
    assert.equal(result.cases[1].guard_diag.guard_neutral, false);
    assert.equal(result.cases[1].native_denial, false);
    assert.equal(result.cases[1].outcome, 'NOT_PROVEN');
  }
  const value = fixture();
  value.messages.push({ type: 'system', subtype: 'hook_response', hook_event: 'PreToolUse', outcome: 'error', exit_code: 1 });
  assert.equal(evaluate(value).verdict, 'NOT_PROVEN');
  const stdoutDeny = fixture();
  stdoutDeny.messages.push({ type: 'system', subtype: 'hook_response', hook_event: 'PreToolUse', outcome: 'success', exit_code: 0,
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } }) });
  assert.equal(evaluate(stdoutDeny).verdict, 'NOT_PROVEN');
});

test('native denial without a correlated error tool result is not proof', () => {
  const value = fixture();
  value.messages[1].message.content = value.messages[1].message.content.filter(result => result.tool_use_id !== 'call-1');
  const proof = evaluate(value);
  assert.equal(proof.verdict, 'NOT_PROVEN');
  assert.equal(proof.cases[1].outcome, 'NOT_PROVEN');
});

test('guard audit remains exact-only when native hook input expands a planned alias', () => {
  const value = fixture();
  value.manifest.home = '/fake';
  const result = guardProcesses(value.manifest, [{ hook_event_name: 'PreToolUse', tool_name: 'Read',
    tool_use_id: 'expanded-hook', tool_input: { file_path: '/fake/public/control-home.txt' } }]);
  assert.equal(result.decisions[0].hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(result.records[0].decision, 'deny');
  assert.equal(result.records[0].case_index, -1);
  assert.equal(result.records[0].expanded_case_index, 15);
});

test('missing duplicate malformed unknown or cross-case guard audits never establish native proof', () => {
  for (const mutate of [
    value => { value.guard_events = null; },
    value => { value.guard_events = []; },
    value => { value.guard_events.push({ ...value.guard_events[1] }); },
    value => { value.guard_events[1].decision = 'deny'; },
    value => { value.guard_events[1].case_index = 2; },
    value => { value.guard_events[1].tool = 'Glob'; },
    value => { value.guard_events[1].unexpected_raw_input = '/private'; },
    value => { value.guard_events[1].id_sha256 = 'f'.repeat(64); },
    value => { value.guard_events[1].case_index = true; },
  ]) {
    const value = fixture(); mutate(value);
    const result = evaluate(value);
    assert.equal(result.verdict, 'NOT_PROVEN');
    const item = result.cases.find(item => item.id === 'Read-home');
    assert.equal(item.native_denial, false);
    assert.equal(item.outcome, 'NOT_PROVEN');
    assert.equal(item.guard_diag.guard_neutral, false);
  }
  const value = fixture();
  assert.equal(integration(value.messages, false, null).proof.verdict, 'NOT_PROVEN');
  assert.equal(integration(value.messages, false, [{ malformed: true }]).proof.verdict, 'NOT_PROVEN');
});

test('audit failure cannot suppress observed exposure and new alias controls must actually succeed', () => {
  const exposure = fixture(); exposure.guard_events = null;
  exposure.messages[1].message.content.push({ type: 'tool_result', tool_use_id: 'call-1', content: exposure.manifest.denied_value });
  assert.equal(evaluate(exposure).verdict, 'READ_ISOLATION_FAIL');
  const malformed = [...exposure.messages, { type: 'assistant', message: 'malformed' }];
  assert.equal(integration(malformed, false, null).proof.verdict, 'READ_ISOLATION_FAIL');
  for (const id of ['call-15', 'call-16']) {
    const value = fixture();
    value.messages[1].message.content = value.messages[1].message.content.filter(result => result.tool_use_id !== id);
    assert.equal(evaluate(value).verdict, 'NOT_PROVEN');
  }
  const proof = evaluate(fixture());
  assert.doesNotMatch(JSON.stringify(proof), /id_sha256|call-0|\/fake\//);
});

test('missing null empty and non-string native identities cannot prove isolation', () => {
  for (const identity of [undefined, null, '', 7, {}, []]) {
    const value = fixture();
    const call = value.messages[0].message.content[1];
    const denial = value.messages[2].permission_denials[0];
    if (identity === undefined) { delete call.id; delete denial.tool_use_id; }
    else { call.id = identity; denial.tool_use_id = identity; }
    const result = integration(value.messages);
    assert.equal(result.proof.verdict, 'NOT_PROVEN');
    assert.equal(result.status, 1);
  }
  for (const record of ['result', 'denial']) {
    for (const identity of [undefined, null, '', '   ', 7, {}, []]) {
      const value = fixture();
      const target = record === 'result' ? value.messages[1].message.content[0] : value.messages[2].permission_denials[0];
      if (identity === undefined) delete target.tool_use_id;
      else target.tool_use_id = identity;
      assert.equal(integration(value.messages).proof.verdict, 'NOT_PROVEN');
    }
  }
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

test('native mismatch diagnostics are bounded flags, never raw input, and never relax acceptance', () => {
  const value = fixture();
  value.manifest.home = '/fake';
  value.manifest.cases[1].input = { path: '~/.aws/home/denied.txt' };
  value.manifest.cases[4].input = { path: '/fake/public/../.aws/normalized/denied.txt' };
  value.messages[0].message.content[1].input = value.manifest.cases[1].input;
  value.messages[0].message.content[4].input = value.manifest.cases[4].input;
  const denials = value.messages[2].permission_denials;
  denials.find(d => d.tool_use_id === 'call-1').tool_input = { path: '/fake/.aws/home/denied.txt' };
  denials.find(d => d.tool_use_id === 'call-4').tool_input = { path: '/fake/.aws/normalized/denied.txt' };
  const result = evaluate(value);
  assert.equal(result.verdict, 'NOT_PROVEN');
  for (const id of ['Read-home', 'Read-normalized']) {
    const item = result.cases.find(c => c.id === id);
    assert.equal(item.native_denial, false);
    assert.equal(item.outcome, 'NOT_PROVEN');
    assert.deepEqual(item.native_diag, {
      id_denials: 1, tool_name_match: true, input_keys_match: true, input_types_match: true,
      exact_input_match: false, call_has_tilde: id === 'Read-home', call_has_dotdot: id === 'Read-normalized',
      denial_has_tilde: false, denial_has_dotdot: false, denial_is_expansion_of_call: true,
      result_count: 1, result_error_count: 1,
    });
  }
  assert.doesNotMatch(JSON.stringify(result), /\/fake\/|denied\.txt|\.\.\//);
  const exact = result.cases.find(c => c.id === 'Read-absolute');
  assert.equal(exact.native_diag.exact_input_match, true);
});
