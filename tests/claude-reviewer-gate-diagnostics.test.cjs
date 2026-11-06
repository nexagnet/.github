'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync, writeFileSync, mkdtempSync, rmSync} = require('node:fs');
const {spawnSync} = require('node:child_process');
const {tmpdir} = require('node:os');
const path = require('node:path');

const source = readFileSync(path.join(__dirname, '../.github/workflows/claude-reviewer.yml'), 'utf8').replaceAll('\r\n', '\n');
const gate = source.split('        run: |\n')[1].split('\n  review:')[0]
  .split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
const sha = 'a'.repeat(40);
const repo = 'nexagnet/test-consumer';
const contract = ['OBJECTIVE', 'SCOPE', 'OUT OF SCOPE', 'ACCEPTANCE', 'RISK', 'RUNTIME PROOF', 'STOP CONDITIONS']
  .map(h => '## ' + h).join('\n');
const fixtures = () => ({
  event: {action: 'completed', workflow_run: {id: 88, event: 'pull_request', conclusion: 'success'}},
  pr: {state: 'open', body: 'Refs #7', user: {login: 'phungtienviet14-sketch', type: 'User'},
    head: {sha, ref: 'claude/test', repo: {full_name: repo}},
    base: {sha: 'b'.repeat(40), ref: 'main', repo: {full_name: repo}}},
  comments: [{user: {login: 'phungtienviet14-sketch', type: 'User'}, body: 'NEXAGNET_REVIEW_REQUEST HEAD_SHA=' + sha}],
  issue: {state: 'open', labels: [{name: 'risk:R1'}], body: contract},
  run: {name: 'ci', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success',
    event: 'pull_request', head_sha: sha, repository: {full_name: repo}, pull_requests: [{number: 42}]},
  jobs: {total_count: 2, jobs: ['verify', 'integration'].map(name => ({name, status: 'completed', conclusion: 'success'}))},
  files: [{filename: 'src/example.js'}]
});

function execute(change = x => x, env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'reviewer-gate-'));
  const portable = dir.replaceAll('\\', '/');
  try {
    const data = change(fixtures());
    for (const [key, value] of Object.entries(data)) writeFileSync(path.join(dir, key + '.json'), JSON.stringify(value));
    for (const name of ['output', 'summary']) writeFileSync(path.join(dir, name), '');
    const mock = `gh() {
      if [ "\${FAIL_API:-}" = "1" ]; then echo 'UNTRUSTED_API_CANARY' >&2; return 22; fi
      case "$*" in
        "api repos/${repo}/pulls/42") cat "$FIXTURES/pr.json" ;;
        "api repos/${repo} --jq .default_branch") echo main ;;
        "api repos/${repo}/issues/42/comments?per_page=100") cat "$FIXTURES/comments.json" ;;
        "api repos/${repo}/issues/7") cat "$FIXTURES/issue.json" ;;
        "api repos/${repo}/actions/runs/88") cat "$FIXTURES/run.json" ;;
        "api repos/${repo}/actions/runs/88/jobs?per_page=100") cat "$FIXTURES/jobs.json" ;;
        "api repos/${repo}/pulls/42/files?per_page=100") cat "$FIXTURES/files.json" ;;
        *) echo 'UNEXPECTED_API_CALL' >&2; return 97 ;;
      esac
    }\n`;
    writeFileSync(path.join(dir, 'gate.sh'), mock + gate);
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
    const result = spawnSync(bash, ['--noprofile', '--norc', portable + '/gate.sh'], {
      encoding: 'utf8', env: {...process.env, FIXTURES: portable, GITHUB_REPOSITORY_OWNER: 'nexagnet',
        GITHUB_REPOSITORY: repo, GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: portable + '/event.json',
        GITHUB_OUTPUT: portable + '/output', GITHUB_STEP_SUMMARY: portable + '/summary',
        PR: '42', SHA: sha, RUN: '88', REQUIRED: 'verify,integration', ...env}
    });
    assert.ifError(result.error);
    return {...result, output: readFileSync(path.join(dir, 'output'), 'utf8'),
      summary: readFileSync(path.join(dir, 'summary'), 'utf8')};
  } finally { rmSync(dir, {recursive: true, force: true}); }
}

test('valid owner and Publisher lanes retain successful gate outputs', () => {
  for (const change of [x => x, x => ({...x, pr: {...x.pr,
    user: {login: 'nexagnet-builder-publisher[bot]', type: 'Bot'},
    head: {...x.pr.head, ref: 'claude/issue-7-88-1'}}})]) {
    const result = execute(change);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /head=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
    assert.match(result.output, /issue=7/);
    assert.equal(result.summary, '');
  }
});

const cases = [
  ['ISSUE_REFERENCE_MISSING', x => ({...x, pr: {...x.pr, body: 'No task link UNTRUSTED_BODY_CANARY'}})],
  ['ISSUE_REFERENCE_AMBIGUOUS', x => ({...x, pr: {...x.pr, body: 'Refs #7\nCloses #8'}})],
  ['PR_HEAD_OR_STATE', x => ({...x, pr: {...x.pr, state: 'closed'}})],
  ['PR_HEAD_OR_STATE', x => ({...x, pr: {...x.pr, head: {...x.pr.head, sha: 'c'.repeat(40)}}})],
  ['PR_PROVENANCE', x => ({...x, pr: {...x.pr, user: {login: 'attacker', type: 'User'}}})],
  ['OWNER_ATTESTATION', x => ({...x, comments: []})],
  ['OWNER_ATTESTATION', x => ({...x, comments: [{...x.comments[0], user: {login: 'attacker', type: 'User'}}]})],
  ['OWNER_ATTESTATION', x => ({...x, comments: [{...x.comments[0], body: 'NEXAGNET_REVIEW_REQUEST HEAD_SHA=' + 'c'.repeat(40)}]})],
  ['ISSUE_STATE', x => ({...x, issue: {...x.issue, state: 'closed'}})],
  ['ISSUE_RISK', x => ({...x, issue: {...x.issue, labels: [{name: 'risk:R3'}]}})],
  ['TASK_CONTRACT', x => ({...x, issue: {...x.issue, body: 'UNTRUSTED_CONTRACT_CANARY'}})],
  ['CI_RUN', x => ({...x, run: {...x.run, head_sha: 'c'.repeat(40)}})],
  ['CI_JOBS', x => ({...x, jobs: {...x.jobs, jobs: x.jobs.jobs.slice(0, 1)}})],
  ['PROTECTED_PATHS', x => ({...x, files: [{filename: '.github/UNTRUSTED_PATH_CANARY.yml'}]})],
  ['INPUTS', x => x, {SHA: 'invalid'}],
  ['SOURCE_EVENT', x => ({...x, event: {...x.event, action: 'requested'}})],
  ['API_PR', x => x, {FAIL_API: '1'}]
];
for (const [reason, change, env] of cases) test('gate failure reports ' + reason, () => {
  const result = execute(change, env);
  assert.notEqual(result.status, 0);
  assert.equal(result.output, '', 'failed gate cannot emit review success outputs');
  assert.match(result.stdout, new RegExp('REVIEWER_GATE_BLOCKED: ' + reason));
  assert.match(result.summary, new RegExp('Reason: `' + reason + '`'));
  assert.doesNotMatch(result.stdout + result.stderr + result.summary, /UNTRUSTED_(BODY|CONTRACT|PATH|API)_CANARY/);
  assert.doesNotMatch(result.stdout + result.summary, /NEXAGNET_REVIEWER PASS|nexagnet-review-v1/);
});
