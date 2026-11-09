'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {tmpdir} = require('node:os');
const {spawnSync} = require('node:child_process');
const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/claude-reviewer.yml'), 'utf8').replaceAll('\r\n', '\n');
const block = workflow.match(/      - name: Diagnose failed Claude SDK execution\n([\s\S]*?)(?=\n  report:)/)?.[1] || '';
const code = block.split('        run: |\n')[1]?.split('\n').map(line => line.replace(/^          /, '')).join('\n') || '';
const canary = 'SECRET_CANARY\n::error::INJECTED_CANARY\n$(touch EXECUTED_CANARY)';
const success = {type: 'result', subtype: 'success', is_error: false, structured_output: {verdict: 'PASS'}};
const error = message => ({type: 'result', subtype: 'success', is_error: true, result: message});

function run(messages, options = {}) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'sdk-diagnostic-'));
  const canonical = path.join(dir, 'claude-execution-output.json');
  const summary = path.join(dir, 'summary.md');
  try {
    fs.writeFileSync(summary, '');
    if (options.directory) fs.mkdirSync(canonical);
    else if (options.symlink) {
      const target = path.join(dir, 'target');
      if (process.platform === 'win32') fs.mkdirSync(target);
      else fs.writeFileSync(target, JSON.stringify(messages));
      fs.symlinkSync(target, canonical, process.platform === 'win32' ? 'junction' : 'file');
    } else if (!options.missing) fs.writeFileSync(canonical,
      options.raw ?? JSON.stringify(messages));
    const script = path.join(dir, 'diagnostic.cjs');
    fs.writeFileSync(script, code);
    const child = spawnSync(process.execPath, [script], {encoding: 'utf8', timeout: 10000,
      env: {...process.env, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: summary,
        EXECUTION_FILE: options.outputPath === 'canonical' ? canonical : options.outputPath || ''}});
    assert.ifError(child.error);
    const text = child.stdout + child.stderr + fs.readFileSync(summary, 'utf8');
    assert.equal(child.status, 0, 'diagnostics must not alter failed Action outcome');
    assert.equal(child.stderr, '', 'no raw exceptions or paths');
    assert.doesNotMatch(text, /SECRET_CANARY|INJECTED_CANARY|EXECUTED_CANARY/);
    assert.ok(!text.includes(dir), 'no filesystem path disclosure');
    assert.equal(fs.existsSync(path.join(dir, 'EXECUTED_CANARY')), false);
    assert.equal(fs.existsSync(path.join(dir, 'review-evidence.json')), false);
    return {stdout: child.stdout, summary: fs.readFileSync(summary, 'utf8')};
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

test('failure-only diagnostics preserves hidden output and trusted reporter boundaries', () => {
  assert.ok(code, 'inline diagnostic implementation required');
  assert.match(block, /if: failure\(\) && steps\.claude\.outcome == 'failure'/);
  assert.match(block, /shell: node \{0\}/);
  assert.match(block, /EXECUTION_FILE: \$\{\{ steps\.claude\.outputs\.execution_file \}\}/);
  assert.doesNotMatch(block, /continue-on-error|uses:|GITHUB_OUTPUT|upload-artifact|structured_output:/);
  assert.match(workflow, /show_full_output: 'false'/);
  assert.match(workflow, /if: needs\.review\.result == 'success'/);
  assert.doesNotMatch(code, /console\.error|\.stack|\.message|execSync|spawnSync|fetch\(/);
});

const cases = [
  ['SDK_AUTH_ERROR_HINT', [error('authentication failed ' + canary)]],
  ['SDK_AUTH_ERROR_HINT', [error('OAuth token expired ' + canary)]],
  ['SDK_AUTH_ERROR_HINT', [{type: 'assistant', error: 'authentication_failed', message: canary}, error('unknown')]],
  ['SDK_RATE_LIMIT_HINT', [error('rate limit exceeded ' + canary)]],
  ['SDK_RATE_LIMIT_HINT', [{type: 'assistant', error: 'rate_limit', message: canary}, error('unknown')]],
  ['SDK_MODEL_ERROR_HINT', [error('model not found ' + canary)]],
  ['SDK_MODEL_ERROR_HINT', [{type: 'result', subtype: 'error_during_execution', errors: ['unsupported model ' + canary]}]],
  ['SDK_ERROR_UNKNOWN', [error(canary)]],
  ['SDK_ERROR_UNKNOWN', [{type: 'result', subtype: 'error_max_turns', result: canary}]],
  ['SDK_OUTPUT_MISSING', [{type: 'result', subtype: 'success', is_error: false, result: 'auth rate limit model not found ' + canary}]],
  ['SDK_DIAGNOSTIC_UNAVAILABLE', [success]],
  ['SDK_DIAGNOSTIC_UNAVAILABLE', [], {missing: true}],
  ['SDK_DIAGNOSTIC_UNAVAILABLE', [], {directory: true}],
  ['SDK_DIAGNOSTIC_UNAVAILABLE', [], {raw: '{' + canary}],
  ['SDK_DIAGNOSTIC_UNAVAILABLE', [], {raw: 'x'.repeat(5 * 1024 * 1024 + 1)}],
  ['SDK_DIAGNOSTIC_UNAVAILABLE', {type: 'result', result: 'authentication failed'}],
  ['SDK_DIAGNOSTIC_UNAVAILABLE', [error('authentication failed'), error('rate limit')]],
  ['SDK_DIAGNOSTIC_UNAVAILABLE', [error('authentication failed'), {type: 'assistant', message: canary}]],
  ['SDK_DIAGNOSTIC_UNAVAILABLE', [error('authentication failed')], {outputPath: '../' + canary}],
  ['SDK_AUTH_ERROR_HINT', [error('authentication failed')], {outputPath: 'canonical'}],
  ['SDK_ERROR_UNKNOWN', [{type: 'user', message: 'authentication failed ' + canary}, error('unknown')]],
  ['SDK_ERROR_UNKNOWN', [{type: 'assistant', message: {content: 'rate limit ' + canary}}, error('unknown')]],
  ['SDK_ERROR_UNKNOWN', [{type: 'tool_result', content: 'model not found ' + canary}, error('unknown')]],
  ['SDK_ERROR_UNKNOWN', [{type: 'assistant', error: 'authentication_failed ' + canary}, error('unknown')]],
  ['SDK_ERROR_UNKNOWN', [{type: 'result', subtype: 'success', is_error: true,
    result: {text: 'authentication failed ' + canary}, errors: [{message: 'rate limit ' + canary}]}]],
  ['SDK_OUTPUT_MISSING', [{type: 'user', message: 'authentication failed ' + canary},
    {type: 'tool_result', content: 'rate limit ' + canary}, {type: 'result', subtype: 'success', is_error: false}]]
];
for (const [expected, messages, options] of cases) test('fixed SDK diagnostic ' + expected, () => {
  const result = run(messages, options);
  assert.match(result.stdout, new RegExp('REVIEWER_SDK_DIAGNOSTIC: ' + expected));
  assert.match(result.summary, new RegExp('`' + expected + '`'));
  assert.match(result.summary, /advisory/i);
  assert.doesNotMatch(result.stdout + result.summary, /NEXAGNET_REVIEWER PASS|nexagnet-review-v1/);
});

test('canonical transcript symlink is rejected without following target', () => {
  const result = run([error('authentication failed ' + canary)], {symlink: true});
  assert.match(result.stdout, /SDK_DIAGNOSTIC_UNAVAILABLE/);
});
