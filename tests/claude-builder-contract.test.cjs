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
const validator = publish.steps.find(s => s.name.startsWith('Validate patch')).run;

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
  assert.ok(!JSON.stringify(agent).includes('BUILDER_PUBLISHER_APP_PRIVATE_KEY'));
  const step = agent.steps.find(s => s.name.startsWith('Claude proposes'));
  assert.equal(step.with.github_token, '\${{ github.token }}');
  assert.match(step.with.claude_args, /--disallowedTools "Bash,WebFetch,WebSearch"/);
});

test('privileged publisher is strictly downstream from validation', () => {
  assert.deepEqual(publish.needs, ['preflight', 'agent']);
  assert.equal(publish.permissions.contents, 'read');
  const validatorIdx = publish.steps.findIndex(s => s.name.startsWith('Validate patch'));
  const tokenIdx = publish.steps.findIndex(s => s.id === 'publisher');
  assert.ok(validatorIdx >= 0 && tokenIdx > validatorIdx);
  assert.equal(publish.steps[tokenIdx].with['permission-contents'], 'write');
  assert.equal(publish.steps[tokenIdx].with['permission-pull-requests'], 'write');
  assert.equal(publish.steps[tokenIdx].with['permission-workflows'], undefined);
  assert.match(validator, /git apply --check --index/);
  assert.match(validator, /Base HEAD changed/);
  assert.match(validator, /risk:\$EXPECTED_RISK/);
  assert.match(publish.steps.at(-1).run, /-F draft=true/);
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
    'src/AGENTS.md', 'CLAUDE.md', '.mcp.json',
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

test('preflight rejects invalid actor/event and missing/conflicting/R3 risk', () => {
  const folder = mkdtempSync(join(tmpdir(), 'nexagnet-builder-'));
  try {
    const bin = join(folder, 'bin');
    mkdirSync(bin);
    const gh = join(bin, 'gh');
    writeFileSync(gh, [
      '#!/bin/bash',
      'set -euo pipefail',
      'case "$*" in',
      '  "api repos/nexagnet/example/issues/12") cat "$MOCK_ISSUE" ;;',
      '  "api repos/nexagnet/example --jq .default_branch") echo main ;;',
      '  "api repos/nexagnet/example/branches/main --jq .commit.sha") printf "a%.0s" {1..40}; echo ;;',
      '  *) echo "unknown gh invocation" >&2; exit 2 ;;',
      'esac'
    ].join('\n'), { mode: 0o755 });
    const eventFile = join(folder, 'event.json');
    const issueFile = join(folder, 'issue.json');
    const outFile = join(folder, 'output');
    const headings = ['OBJECTIVE','SCOPE','OUT OF SCOPE','ACCEPTANCE','RISK','RUNTIME PROOF','STOP CONDITIONS']
      .map(h => '## ' + h).join('\n');
    const validEvent = { action: 'created', issue: { number: 12 }, comment: { user: { login: 'phungtienviet14-sketch' }, body: '@claude' } };
    const validIssue = { state: 'open', labels: [{name:'risk:R1'}], body: headings };
    function call(event, issue, actor = 'phungtienviet14-sketch') {
      writeFileSync(eventFile, JSON.stringify(event));
      writeFileSync(issueFile, JSON.stringify(issue));
      writeFileSync(outFile, '');
      return spawnSync('bash', ['-c', preflight], {
        encoding: 'utf8',
        env: {
          ...process.env, PATH: bin + ':' + process.env.PATH,
          GITHUB_REPOSITORY_OWNER: 'nexagnet', GITHUB_REPOSITORY: 'nexagnet/example',
          GITHUB_EVENT_NAME: 'issue_comment', GITHUB_ACTOR: actor,
          GITHUB_EVENT_PATH: eventFile, GITHUB_OUTPUT: outFile, ISSUE_NUMBER: '12',
          MOCK_ISSUE: issueFile, GH_TOKEN: 'test-read-only-token'
        }
      }).status === 0;
    }
    assert.equal(call(validEvent, validIssue), true);
    assert.equal(call(validEvent, { ...validIssue, state: 'closed' }), false);
    assert.equal(call(validEvent, { ...validIssue, labels: [{name:'risk:R3'}] }), false);
    assert.equal(call(validEvent, { ...validIssue, labels: [{name:'risk:R1'},{name:'risk:R2'}] }), false);
    assert.equal(call(validEvent, { ...validIssue, body:'## OBJECTIVE' }), false);
    assert.equal(call({...validEvent, action:'edited'}, validIssue), false);
    assert.equal(call({...validEvent, issue:{number:12, pull_request:{url:'x'}}}, validIssue), false);
    assert.equal(call(validEvent, validIssue, 'untrusted-user'), false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
