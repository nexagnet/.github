'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync} = require('node:fs');
const {spawnSync} = require('node:child_process');
const {tmpdir} = require('node:os');
const path = require('node:path');

const source = readFileSync(path.join(__dirname, '../.github/workflows/claude-autonomy.yml'), 'utf8').replaceAll('\r\n', '\n');
const unindent = text => text.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
const after = (text, marker) => text.slice(text.indexOf(marker) + marker.length);
const RUN = '        run: |\n';
const decideJob = source.split('\n  merge:')[0];
const mergeJob = 'merge:' + source.split('\n  merge:')[1].split('\n  notify:')[0];
const notifyJob = source.split('\n  notify:')[1];
const scripts = {
  decide: unindent(after(decideJob, RUN)),
  recheck: unindent(after(mergeJob, RUN).split('\n      - id: app_token')[0]),
  merge: unindent(after(after(mergeJob, 'Merge squash'), RUN)),
  notify: unindent(after(notifyJob, RUN))
};

const sha = 'a'.repeat(40);
const repo = 'nexagnet/test-consumer';
const owner = {login: 'phungtienviet14-sketch', type: 'User'};
const fixtures = () => ({
  event: {action: 'completed', workflow_run: {id: 500, conclusion: 'success'}},
  review_run: {name: 'Nexagnet Reviewer caller', path: '.github/workflows/nexagnet-claude-reviewer.yml',
    event: 'workflow_run', status: 'completed', conclusion: 'success', head_branch: 'main', repository: {full_name: repo}},
  evidence: {schema: 'nexagnet-review-v1', pr: 42, head_sha: sha, ci_run_id: 88, issue: null, risk: 'none',
    review: {head_sha: sha, verdict: 'PASS', diff_inspected: true, findings: []}},
  pr: {state: 'open', merged: false, draft: false, labels: [], user: owner,
    head: {sha, ref: 'claude/x', repo: {full_name: repo}}, base: {ref: 'main', repo: {full_name: repo}}},
  ci: {name: 'ci', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success',
    event: 'pull_request', head_sha: sha, repository: {full_name: repo}, pull_requests: [{number: 42}]},
  latest: {workflow_runs: [{id: 88, status: 'completed', conclusion: 'success'}]},
  jobs: {total_count: 2, jobs: ['domain-tests', 'meta-check'].map(name => ({name, status: 'completed', conclusion: 'success'}))},
  rules: [{type: 'pull_request', parameters: {}},
    {type: 'required_status_checks', parameters: {required_status_checks: [{context: 'domain-tests'}, {context: 'meta-check'}]}}],
  files: [{filename: 'Assets/Scripts/A.cs'}],
  comments: []
});

// Mô phỏng `gh`: mỗi lời gọi được ghi vào calls.log để kiểm chứng (đặc biệt là PUT merge).
const mock = `gh() {
  echo "$*" >> "$FIXTURES/calls.log"
  if [ "\${FAIL_ON:-}" != "" ] && [[ "$*" == *"$FAIL_ON"* ]]; then echo 'UNTRUSTED_API_CANARY' >&2; return 22; fi
  case "$*" in
    "api repos/${repo} --jq .default_branch") echo main ;;
    "api repos/${repo}/actions/runs/500") cat "$FIXTURES/review_run.json" ;;
    "run download 500 -n nexagnet-review-evidence -D $RUNNER_TEMP/evidence --repo ${repo}")
      [ -f "$FIXTURES/evidence.json" ] || return 1
      cp "$FIXTURES/evidence.json" "$RUNNER_TEMP/evidence/review-evidence.json" ;;
    "api repos/${repo}/pulls/42") cat "$FIXTURES/pr.json" ;;
    "api repos/${repo}/pulls/42 --jq .merged == true") jq '.merged == true' "$FIXTURES/pr_after.json" ;;
    "api repos/${repo}/actions/runs/88") cat "$FIXTURES/ci.json" ;;
    "api repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=pull_request&per_page=10") cat "$FIXTURES/latest.json" ;;
    "api repos/${repo}/actions/runs/88/jobs?per_page=100") cat "$FIXTURES/jobs.json" ;;
    "api repos/${repo}/rules/branches/main?per_page=100") cat "$FIXTURES/rules.json" ;;
    "api --paginate repos/${repo}/pulls/42/files?per_page=100 --jq .[]") jq -c '.[]' "$FIXTURES/files.json" ;;
    "api -X PUT repos/${repo}/pulls/42/merge -f sha=${sha} -f merge_method=squash")
      if [ -f "$FIXTURES/merge_fail" ]; then echo 'gh: Head branch was modified (HTTP 409)'; return 1; fi
      echo '{"merged":true}' ;;
    "api --paginate repos/${repo}/issues/42/comments?per_page=100 --jq .[].body") jq -r '.[]' "$FIXTURES/comments.json" ;;
    "api -X POST repos/${repo}/issues/42/comments --input - --jq .html_url") cat >> "$FIXTURES/posted.json"; echo posted ;;
    *) echo 'UNEXPECTED_API_CALL' >&2; return 97 ;;
  esac
}
`;

function execute(name, change = x => x, env = {}, extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'autonomy-'));
  const portable = dir.replaceAll('\\', '/');
  try {
    const data = change(fixtures());
    for (const [key, value] of Object.entries(data)) if (value !== undefined) writeFileSync(path.join(dir, key + '.json'), JSON.stringify(value));
    for (const file of ['output', 'summary', 'calls.log']) writeFileSync(path.join(dir, file), '');
    mkdirSync(path.join(dir, 'tmp'));
    if (extra.mergeFail) writeFileSync(path.join(dir, 'merge_fail'), '1');
    if (extra.after) writeFileSync(path.join(dir, 'pr_after.json'), JSON.stringify(extra.after));
    writeFileSync(path.join(dir, 'script.sh'), mock + scripts[name]);
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
    const result = spawnSync(bash, ['--noprofile', '--norc', portable + '/script.sh'], {
      encoding: 'utf8', timeout: 30000,
      env: {...process.env, FIXTURES: portable, RUNNER_TEMP: portable + '/tmp', GITHUB_REPOSITORY_OWNER: 'nexagnet',
        GITHUB_REPOSITORY: repo, GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: portable + '/event.json',
        GITHUB_OUTPUT: portable + '/output', GITHUB_STEP_SUMMARY: portable + '/summary',
        RUN: '500', REQUIRED: 'domain-tests,meta-check', AUTHORS: owner.login, EXTRA_SENSITIVE: '',
        PR: '42', SHA: sha, BASE: 'main', CI_RUN: '88', DECISION: 'MANUAL', REASON: 'SENSITIVE_PATH', ...env}
    });
    assert.ifError(result.error);
    const read = file => readFileSync(path.join(dir, file), 'utf8');
    return {...result, output: read('output'), calls: read('calls.log'),
      posted: existsSync(path.join(dir, 'posted.json')) ? read('posted.json') : ''};
  } finally { rmSync(dir, {recursive: true, force: true}); }
}

const decide = (change, env) => execute('decide', change, env);
const expectDecision = (result, decision, reason) => {
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.output, new RegExp(`decision=${decision}\\n`));
  assert.match(result.output, new RegExp(`reason=${reason}\\n`));
};
const expectBlocked = (result, reason) => {
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, new RegExp(`AUTONOMY_BLOCKED: ${reason}\\.`));
  assert.doesNotMatch(result.output, /decision=MERGE/);
  assert.doesNotMatch(result.stdout + result.stderr, /UNTRUSTED_API_CANARY/);
};

test('workflow uses the minimal contract: no AI, no auto-merge flag, no bypass, App token only after recheck', () => {
  assert.doesNotMatch(source, /claude-code-action|anthropics\/|ANTHROPIC|CLAUDE_CODE_OAUTH/);
  assert.doesNotMatch(source.replace(/^\s*#.*$/gm, ''), /--auto|enable_pr_auto_merge|--admin|bypass_pull_request_allowances/);
  assert.match(source, /^permissions: \{\}$/m);
  assert.match(source, /group: nexagnet-autonomy-\$\{\{ github\.repository \}\}\n\s+cancel-in-progress: false/);
  assert.match(source, /merge_method=squash/);
  assert.match(source, /-f sha="\$SHA"/);
  assert.match(source, /actions\/create-github-app-token@[0-9a-f]{40}/);
  const mergeAt = source.indexOf('\n  merge:');
  assert.ok(source.indexOf('create-github-app-token') > mergeAt);
  assert.ok(source.indexOf('id: recheck') < source.indexOf('create-github-app-token'));
  // Phần quyết định không bao giờ có quyền ghi.
  assert.doesNotMatch(decideJob.split('outputs:')[0], /write/);
});

test('case 12: normal PASS + green CI + Ready + ruleset => MERGE exactly this HEAD', () => {
  const result = decide();
  expectDecision(result, 'MERGE', 'ELIGIBLE');
  assert.match(result.output, new RegExp(`sha=${sha}\\n`));
  assert.match(result.output, /pr=42\n/);
  assert.doesNotMatch(result.calls, /-X PUT|-X POST/);
});

test('case 11: sensitive paths are never auto-merged', () => {
  for (const file of ['.github/workflows/ci.yml', '.claude/settings.json', 'CLAUDE.md', 'sub/AGENTS.md', '.mcp.json',
    '.env.local', 'infra/main.tf', 'deploy/run.sh', 'tools/autopilot/x.sh']) {
    expectDecision(decide(x => ({...x, files: [{filename: 'ok.cs'}, {filename: file}]})), 'MANUAL', 'SENSITIVE_PATH');
  }
  const rename = decide(x => ({...x, files: [{filename: 'docs/a.md', previous_filename: '.github/workflows/x.yml'}]}));
  expectDecision(rename, 'MANUAL', 'SENSITIVE_PATH');
  for (const file of ['ProjectSettings/ProjectSettings.asset', 'Packages/manifest.json']) {
    const result = decide(x => ({...x, files: [{filename: file}]}), {EXTRA_SENSITIVE: '^(ProjectSettings/|Packages/manifest\\.json)'});
    expectDecision(result, 'MANUAL', 'SENSITIVE_PATH');
  }
  expectDecision(decide(x => ({...x, files: [{filename: 'ProjectSettings/a.asset'}]})), 'MERGE', 'ELIGIBLE');
});

test('case 13: Draft with an old PASS, or needs-human label => no merge', () => {
  expectDecision(decide(x => ({...x, pr: {...x.pr, draft: true}})), 'NONE', 'DRAFT');
  expectDecision(decide(x => ({...x, pr: {...x.pr, labels: [{name: 'needs-human'}]}})), 'NONE', 'NEEDS_HUMAN');
});

test('stale HEAD, closed/merged PR, missing evidence, non-PASS verdicts => no merge and no red', () => {
  expectDecision(decide(x => ({...x, pr: {...x.pr, head: {...x.pr.head, sha: 'c'.repeat(40)}}})), 'NONE', 'STALE_OR_CLOSED');
  expectDecision(decide(x => ({...x, pr: {...x.pr, state: 'closed'}})), 'NONE', 'STALE_OR_CLOSED');
  expectDecision(decide(x => ({...x, pr: {...x.pr, merged: true}})), 'NONE', 'STALE_OR_CLOSED');
  expectDecision(decide(x => ({...x, evidence: undefined})), 'NONE', 'NO_EVIDENCE');
  expectDecision(decide(x => ({...x, evidence: {...x.evidence, review: {...x.evidence.review, verdict: 'REQUEST_CHANGES'}}})), 'NONE', 'NOT_PASS');
});

test('case 16: a second review event for an already merged PR/HEAD does nothing', () => {
  const result = decide(x => ({...x, pr: {...x.pr, state: 'closed', merged: true}}));
  expectDecision(result, 'NONE', 'STALE_OR_CLOSED');
  assert.doesNotMatch(result.calls, /-X PUT/);
});

test('superseded CI run or missing/failed required job => no merge', () => {
  expectDecision(decide(x => ({...x, latest: {workflow_runs: [{id: 99}, {id: 88}]}})), 'NONE', 'CI_SUPERSEDED');
  expectBlocked(decide(x => ({...x, ci: {...x.ci, conclusion: 'failure'}})), 'CI_RUN');
  expectBlocked(decide(x => ({...x, ci: {...x.ci, pull_requests: [{number: 42}, {number: 43}]}})), 'CI_RUN');
  expectBlocked(decide(x => ({...x, ci: {...x.ci, head_sha: 'd'.repeat(40)}})), 'CI_RUN');
  expectBlocked(decide(x => ({...x, jobs: {total_count: 1, jobs: [x.jobs.jobs[0]]}})), 'CI_JOBS');
  expectBlocked(decide(x => ({...x, jobs: {total_count: 2, jobs: [x.jobs.jobs[0], {...x.jobs.jobs[1], conclusion: 'skipped'}]}})), 'CI_JOBS');
});

test('case 20: no effective ruleset with PR + required checks => refuse (red, no merge)', () => {
  expectBlocked(decide(x => ({...x, rules: []})), 'RULESET_MISSING');
  expectBlocked(decide(x => ({...x, rules: [x.rules[0]]})), 'RULESET_MISSING');
  expectBlocked(decide(x => ({...x, rules: [x.rules[0], {type: 'required_status_checks', parameters: {required_status_checks: [{context: 'domain-tests'}]}}]})), 'RULESET_MISSING');
  expectBlocked(decide(x => ({...x, rules: [...x.rules, {type: 'merge_queue', parameters: {}}]})), 'RULESET_MISSING');
});

test('untrusted authors, forks, wrong reviewer run, bad evidence and API failures fail closed', () => {
  expectBlocked(decide(x => ({...x, pr: {...x.pr, user: {login: 'stranger', type: 'User'}}})), 'PR_AUTHOR');
  expectBlocked(decide(x => ({...x, pr: {...x.pr, user: {login: 'nexagnet-builder-publisher[bot]', type: 'User'}}})), 'PR_AUTHOR');
  expectDecision(decide(x => ({...x, pr: {...x.pr, user: {login: 'nexagnet-builder-publisher[bot]', type: 'Bot'}}})), 'MERGE', 'ELIGIBLE');
  expectBlocked(decide(x => ({...x, pr: {...x.pr, head: {...x.pr.head, repo: {full_name: 'fork/test-consumer'}}}})), 'PR_IDENTITY');
  expectBlocked(decide(x => ({...x, pr: {...x.pr, base: {...x.pr.base, ref: 'dev'}}})), 'PR_IDENTITY');
  expectBlocked(decide(x => ({...x, review_run: {...x.review_run, path: '.github/workflows/evil.yml'}})), 'REVIEW_RUN');
  expectBlocked(decide(x => ({...x, review_run: {...x.review_run, head_branch: 'feature'}})), 'REVIEW_RUN');
  expectBlocked(decide(x => ({...x, event: {...x.event, workflow_run: {id: 501, conclusion: 'success'}}})), 'SOURCE_EVENT');
  expectBlocked(decide(x => ({...x, evidence: {...x.evidence, review: {...x.evidence.review, head_sha: 'e'.repeat(40)}}})), 'EVIDENCE');
  expectBlocked(decide(x => ({...x, evidence: {...x.evidence, schema: 'other'}})), 'EVIDENCE');
  expectBlocked(decide(x => ({...x, evidence: {...x.evidence, review: {...x.evidence.review, diff_inspected: false}}})), 'EVIDENCE');
  expectBlocked(decide(x => ({...x, evidence: {...x.evidence, review: {...x.evidence.review,
    findings: [{severity: 'major'}]}}})), 'EVIDENCE');
  expectBlocked(decide(undefined, {REQUIRED: 'only-one'}), 'INPUTS');
  expectBlocked(decide(undefined, {GITHUB_REPOSITORY_OWNER: 'someone'}), 'INPUTS');
  expectBlocked(decide(undefined, {FAIL_ON: 'pulls/42'}), 'API_PR');
  expectBlocked(decide(undefined, {FAIL_ON: 'rules/branches'}), 'API_RULES');
  expectBlocked(decide(undefined, {FAIL_ON: '/files'}), 'API_FILES');
});

test('case 17: recheck stops on a changed HEAD, label, newer CI run, or lost ruleset', () => {
  const recheck = (change, env) => execute('recheck', change, env);
  const ok = recheck();
  assert.equal(ok.status, 0, ok.stdout);
  for (const change of [
    x => ({...x, pr: {...x.pr, head: {...x.pr.head, sha: 'c'.repeat(40)}}}),
    x => ({...x, pr: {...x.pr, draft: true}}),
    x => ({...x, pr: {...x.pr, labels: [{name: 'needs-human'}]}}),
    x => ({...x, pr: {...x.pr, state: 'closed'}}),
    x => ({...x, latest: {workflow_runs: [{id: 99, status: 'completed', conclusion: 'success'}, {id: 88}]}}),
    x => ({...x, latest: {workflow_runs: [{id: 88, status: 'completed', conclusion: 'failure'}]}}),
    x => ({...x, rules: []})
  ]) {
    const result = recheck(change);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /AUTONOMY_BLOCKED: RECHECK/);
  }
});

test('case 17: merge is one PUT with expected HEAD SHA and squash; a stale branch stops without retry or bypass', () => {
  const merged = execute('merge', x => x, {}, {after: {merged: true}});
  assert.equal(merged.status, 0, merged.stdout);
  assert.equal((merged.calls.match(/-X PUT/g) || []).length, 1);
  assert.match(merged.calls, new RegExp(`-X PUT repos/${repo}/pulls/42/merge -f sha=${sha} -f merge_method=squash`));

  const stale = execute('merge', x => x, {}, {mergeFail: true, after: {merged: false}});
  assert.notEqual(stale.status, 0);
  assert.match(stale.stdout, /AUTO_MERGE_STOPPED: .*HTTP 409/);
  assert.equal((stale.calls.match(/-X PUT/g) || []).length, 1);
  assert.doesNotMatch(stale.calls, /--admin|--auto/);

  const unconfirmed = execute('merge', x => x, {}, {after: {merged: false}});
  assert.notEqual(unconfirmed.status, 0, 'exit code 0 from PUT is not trusted without merged==true');
});

test('notify posts one fixed comment per HEAD and never repeats it', () => {
  const manual = execute('notify');
  assert.equal(manual.status, 0, manual.stdout);
  assert.match(manual.posted, new RegExp(`READY_FOR_MANUAL_MERGE HEAD_SHA=${sha} REASON=SENSITIVE_PATH`));

  const again = execute('notify', x => ({...x, comments: [`READY_FOR_MANUAL_MERGE HEAD_SHA=${sha} REASON=SENSITIVE_PATH`]}));
  assert.equal(again.status, 0, again.stdout);
  assert.equal(again.posted, '');

  const stopped = execute('notify', undefined, {DECISION: 'MERGE', REASON: 'ELIGIBLE'});
  assert.match(stopped.posted, new RegExp(`AUTO_MERGE_STOPPED HEAD_SHA=${sha}`));

  const bad = execute('notify', undefined, {SHA: 'not-a-sha'});
  assert.notEqual(bad.status, 0);
  assert.equal(bad.posted, '');
});
