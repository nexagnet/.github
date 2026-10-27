'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const workflowPath = path.join(__dirname, '../.github/workflows/claude-mcp-isolation-probe.yml');
const source = fs.existsSync(workflowPath) ? fs.readFileSync(workflowPath, 'utf8').replaceAll('\r\n', '\n') : '';
const python = process.env.PYTHON || (process.platform === 'win32'
  ? 'C:/Users/phung/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe' : 'python3');

function pythonSource() {
  const match = source.match(/# BEGIN MCP PROBE PYTHON\n([\s\S]*?)          # END MCP PROBE PYTHON/);
  assert.ok(match, 'trusted verifier must be executable rather than a YAML assertion');
  return match[1].split('\n').map(line => line.slice(10)).join('\n');
}

function withVerifier(callback) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'nexagnet-mcp-probe-test-'));
  const script = path.join(folder, 'verifier.py');
  fs.writeFileSync(script, pythonSource());
  try { callback(script, folder); } finally { fs.rmSync(folder, { recursive: true, force: true }); }
}

function execute(script, input) {
  const result = spawnSync(python, [script, 'unit'], { input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function validInput() {
  return {
    control: { action_success: true, cli_version: '2.1.293', init_count: 1, connected_servers: 4, total_servers: 4, read_ok: true, unexpected_tool: false },
    candidate: { action_success: true, cli_version: '2.1.293', init_count: 1, connected_servers: 0, total_servers: 0, read_ok: true, unexpected_tool: false },
    control_events: ['project', 'local', 'user', 'plugin'].flatMap(id => ['startup', 'initialize', 'tools_list'].map(event => ({ id, phase: 'control', event, pid: 123 }))),
    candidate_events: [],
    control_stopped: true,
  };
}

test('MCP probe is separately owner/ref/SHA gated with read-only explicit credentials', () => {
  assert.match(source, /expected_consumer_sha:/);
  assert.match(source, /test "\$GITHUB_SHA" = "\$EXPECTED_CONSUMER_SHA"/);
  for (const item of ['phungtienviet14-sketch', 'nexagnet/legal-office', 'refs/heads/codex/tool-isolation-runtime-36-37', 'workflow_dispatch']) assert.ok(source.includes(item));
  assert.doesNotMatch(source, /secrets: inherit|contents: write|id-token: write|secrets\.BUILDER_PUBLISHER/);
  assert.equal((source.match(/uses: anthropics\/claude-code-action@6fed3ca145920b639991cb756090506e1bcaf515/g) || []).length, 2);
  assert.match(source, /--setting-sources user --strict-mcp-config --mcp-config '\{"mcpServers":\{\}\}'/);
  assert.equal((source.match(/show_full_output: 'false'/g) || []).length, 2);
});

test('executable verifier requires real discovery controls and useful candidate execution', () => {
  withVerifier(script => {
    assert.equal(execute(script, validInput()).verdict, 'MCP_STARTUP_NEGATIVE_PROVEN');
    for (const field of ['action_success', 'read_ok']) {
      for (const phase of ['control', 'candidate']) {
        const input = validInput(); input[phase][field] = false;
        assert.equal(execute(script, input).verdict, 'NOT_PROVEN', phase + ':' + field);
      }
    }
    for (const id of ['project', 'local', 'user', 'plugin']) {
      const input = validInput(); input.control_events = input.control_events.filter(event => event.id !== id);
      assert.equal(execute(script, input).verdict, 'NOT_PROVEN', id);
    }
    const stopped = validInput(); stopped.control_stopped = false;
    assert.equal(execute(script, stopped).verdict, 'NOT_PROVEN');
  });
});

test('actual CLI version must match the reviewed version in both phases', () => {
  withVerifier(script => {
    for (const phase of ['control', 'candidate']) {
      for (const version of ['2.1.294', 'UNVERIFIED', '']) {
        const input = validInput(); input[phase].cli_version = version;
        assert.equal(execute(script, input).verdict, 'NOT_PROVEN');
      }
    }
  });
});

test('unauthorized candidate startup or discovered server fails; malformed evidence is not proof', () => {
  withVerifier(script => {
    const spawn = validInput(); spawn.candidate_events = [{ id: 'project', phase: 'candidate', event: 'startup', pid: 456 }];
    assert.equal(execute(script, spawn).verdict, 'MCP_STARTUP_NEGATIVE_FAIL');
    const server = validInput(); server.candidate.total_servers = 1;
    assert.equal(execute(script, server).verdict, 'MCP_STARTUP_NEGATIVE_FAIL');
    const duplicate = validInput(); duplicate.control_events.push(duplicate.control_events[0]);
    assert.equal(execute(script, duplicate).verdict, 'NOT_PROVEN');
    const unknown = validInput(); unknown.candidate.unexpected_tool = true;
    assert.equal(execute(script, unknown).verdict, 'NOT_PROVEN');
    const malformed = validInput(); malformed.candidate_events = 0;
    assert.equal(execute(script, malformed).verdict, 'NOT_PROVEN');
    const missing = validInput(); delete missing.candidate.connected_servers;
    assert.equal(execute(script, missing).verdict, 'NOT_PROVEN');
    assert.equal(execute(script, {}).verdict, 'NOT_PROVEN');
  });
});

test('fixture is an actual bounded stdio MCP process, never an external endpoint or env reader', () => {
  withVerifier((script, folder) => {
    const env = { ...process.env, RUNNER_TEMP: folder, GITHUB_WORKSPACE: path.join(folder, 'workspace') };
    fs.mkdirSync(env.GITHUB_WORKSPACE);
    const setup = spawnSync(python, [script, 'setup', 'control'], { env, encoding: 'utf8' });
    assert.equal(setup.status, 0, setup.stderr);
    const server = path.join(folder, 'mcp-isolation/public/server.cjs');
    const log = path.join(folder, 'mcp-isolation/private/control.jsonl');
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ].map(JSON.stringify).join('\n') + '\n';
    const run = spawnSync(process.execPath, [server, 'project', 'control', log], { input, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.stdout.trim().split('\n').map(JSON.parse).map(message => message.id), [1, 2]);
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).map(event => event.event), ['startup', 'initialize', 'tools_list']);
    const serverSource = fs.readFileSync(server, 'utf8');
    assert.doesNotMatch(serverSource, /process\.env|https?[:.]|child_process|exec\(/);
  });
});

test('diagnostic tool guard is neutral only for the exact synthetic Read, denies other reads/tools', () => {
  withVerifier((script, folder) => {
    const env = { ...process.env, RUNNER_TEMP: folder };
    const valid = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(folder, 'mcp-isolation/public/control.txt') } };
    const check = value => {
      const run = spawnSync(python, [script, 'guard'], { env, input: JSON.stringify(value), encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      return JSON.parse(run.stdout);
    };
    assert.deepEqual(check(valid), {});
    for (const value of [
      { ...valid, tool_name: 'Bash' },
      { ...valid, tool_input: { file_path: '/unrelated/file' } },
      { ...valid, tool_name: 'mcp__project_canary__ping' },
      {},
    ]) assert.equal(check(value).hookSpecificOutput.permissionDecision, 'deny');
  });
});

test('SDK reduction binds real tool calls/results and requires explicit native init discovery', () => {
  withVerifier((script, folder) => {
    const messages = [
      { type: 'system', subtype: 'init', mcp_servers: [] },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: path.join(folder, 'mcp-isolation/public/control.txt') } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'MCP_LOCAL_READ_CONTROL', is_error: false }] } },
      { type: 'result', subtype: 'success', is_error: false },
    ];
    const check = value => {
      const run = spawnSync(python, [script, 'summarize-unit'], { env: { ...process.env, RUNNER_TEMP: folder }, input: JSON.stringify(value), encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      return JSON.parse(run.stdout);
    };
    assert.equal(check(messages).read_ok, true);
    assert.equal(check(messages).unexpected_tool, false);
    const missingInit = structuredClone(messages); delete missingInit[0].mcp_servers;
    assert.equal(check(missingInit).unexpected_tool, true);
    const forgedRole = structuredClone(messages); forgedRole[2].type = 'assistant';
    assert.equal(check(forgedRole).read_ok, false);
    const mismatched = structuredClone(messages); mismatched[2].message.content[0].tool_use_id = 'other';
    assert.equal(check(mismatched).read_ok, false);
    assert.equal(check([{ type: 'assistant', message: { content: 'MCP_LOCAL_READ_CONTROL' } }]).read_ok, false);
  });
});
