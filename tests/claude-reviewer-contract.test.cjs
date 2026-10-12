'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {execFileSync, spawnSync} = require('node:child_process');
const path = require('node:path');
const repo = path.resolve(__dirname, '..');
const file = path.join(repo, '.github/workflows/claude-reviewer.yml');
const source = readFileSync(file, 'utf8');
const workflow = JSON.parse(execFileSync('ruby', [
  '-ryaml', '-rjson', '-e',
  'puts JSON.generate(YAML.load_file(ARGV[0]))', file
], {encoding: 'utf8'}));
const jobs = workflow.jobs;
const preflight = jobs.gate.steps.find(s => s.id === 'verify').run;
const reviewer = jobs.review.steps.find(s => s.id === 'claude');
const reporter = jobs.report.steps[0].run;

test('workflow_call interface and no implicit permissions', () => {
  const caller = (workflow.on || workflow.true).workflow_call;
  assert.equal(caller.inputs.pr_number.type, 'number');
  assert.equal(caller.inputs.expected_head_sha.required, true);
  assert.equal(caller.inputs.ci_run_id.required, true);
  assert.equal(caller.inputs.required_jobs_csv.required, true);
  assert.equal(caller.secrets.CLAUDE_CODE_OAUTH_TOKEN.required, true);
  assert.deepEqual(workflow.permissions, {});
  assert.ok(!source.includes('secrets: inherit'));
});

test('reviewer is an independent non-writing agent with exact SHA', () => {
  assert.equal(jobs.review.permissions.contents, 'read');
  assert.equal(jobs.review.permissions.issues, 'read');
  assert.equal(jobs.review.permissions['pull-requests'], 'read');
  assert.equal(jobs.review.permissions['id-token'], undefined);
  const checkout = jobs.review.steps[0];
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(checkout.with.ref, '\${{ needs.gate.outputs.head }}');
  assert.equal(reviewer.with.github_token, '\${{ github.token }}');
  assert.match(reviewer.with.claude_args, /--json-schema/);
  assert.match(reviewer.with.claude_args, /--allowedTools "Read,Glob,Grep"/);
  assert.match(reviewer.with.claude_args, /--disallowedTools "Bash,Edit,Write,/);
  assert.equal(reviewer.with.show_full_output, 'false');
  assert.ok(!JSON.stringify(jobs.review).includes('BUILDER_PUBLISHER_APP_PRIVATE_KEY'));
});

test('deterministic preflight verifies exact-head CI, complete job set, issuer and risk', () => {
  for(const token of [
    'workflow_run','workflow_run.id', 'workflow_run.conclusion',
    'pulls/$PR', '.head.sha == $sha', '.head.repo.full_name == $repo',
    '.base.ref == $base', 'risk:R0|risk:R1|risk:R2',
    '.head_sha == $sha', '.conclusion == "success"',
    'actions/runs/$RUN/jobs?per_page=100',
    '.status == "completed"', '.name == $n',
    'length == 1', 'test "$(jq length <<< "$files")" -lt 100',
    'contract=$(printf'
  ]) assert.ok(preflight.includes(token), 'missing: ' + token);
  assert.ok(!preflight.includes('risk:R3) ;;'));
  assert.equal(jobs.gate.permissions['issues'], 'read');
  assert.equal(jobs.gate.permissions['actions'], 'read');
});

test('only publisher bot PRs on issue-specific branch reach Reviewer', () => {
  assert.match(preflight, /claude\/issue-/);
  assert.match(preflight, /nexagnet-builder-publisher\[bot\]/);
  assert.match(preflight, /head\.repo\.full_name == \$repo/);
  assert.match(preflight, /issue_id/);
});

test('protected path gate includes workflow, automation and instruction file attacks', () => {
  const check = preflight.match(/jq -e 'all\(\.\[\];[\s\S]*?' <<< "\$files" >\/dev\/null/);
  assert.ok(check, 'Expected fail-closed protection applied to GitHub PR file listing');
  // Also assert directly on the jq expression; integration proof remains required.
  for(const name of ['.github', '.claude', 'infra/', 'deploy/', 'tools/autopilot/', 'agents', 'claude', 'mcp']) {
    assert.ok(check[0].toLowerCase().includes(name), 'missing guard for: ' + name);
  }
});

test('trusted reporter rechecks PR HEAD, Issue risk and CI run after Claude', () => {
  assert.deepEqual(jobs.report.needs, ['gate','review']);
  assert.equal(jobs.report.permissions.contents, 'read');
  assert.equal(jobs.report.permissions.issues, 'read');
  assert.equal(jobs.report.permissions['pull-requests'], 'write');
  assert.equal(jobs.report.permissions['id-token'], undefined);
  assert.equal(jobs.report.permissions.contents, 'read');
  assert.equal(jobs.report.permissions['id-token'], undefined);
  assert.match(reporter, /\.head\.sha == \$sha/);
  assert.match(reporter, /\.head_sha == \$sha/);
  assert.match(reporter, /risk:\$RISK/);
  assert.match(reporter, /REQUEST_CHANGES/);
  assert.match(reporter, /Not merge authorization/);
  assert.doesNotMatch(reporter, /gh pr merge|git push|repository_dispatch/);
});

test('Reviewer creates trusted run-scoped structured evidence only after revalidation', () => {
  const reporter = jobs.report;
  assert.ok(reporter.steps[0].run.includes('review-evidence.json'));
  assert.match(reporter.steps[0].run, /nexagnet-review-v1/);
  assert.match(reporter.steps[0].run, /ci_run_id/);
  const artifact = reporter.steps.find(s => s.name?.startsWith('Upload exact-head reviewer evidence'));
  assert.ok(artifact);
  assert.equal(artifact.with.name,'nexagnet-review-evidence');
  assert.equal(artifact.with['if-no-files-found'],'error');
  assert.equal(artifact.with['retention-days'],14);
});

test('every external action is pinned to 40-character immutable SHA', () => {
  const actions = [...source.matchAll(/uses: ([^\s]+)@([^\s]+)/g)];
  assert.ok(actions.length >= 2);
  for(const [, name, sha] of actions) {
    assert.match(sha, /^[0-9a-f]{40}$/, name);
  }
});

test('Independent Reviewer bootstraps bubblewrap before the scrubbed Claude action', () => {
  const review = jobs.review;
  const install = review.steps.find(s => s.name === 'Install bubblewrap for isolated Claude subprocesses');
  assert.ok(install, 'bubblewrap prerequisite is required');
  assert.ok(review.steps.indexOf(install) < review.steps.indexOf(reviewer));
  assert.match(install.run, /set -euo pipefail/);
  assert.match(install.run, /sudo apt-get install -y --no-install-recommends bubblewrap/);
  assert.match(install.run, /command -v bwrap/);
  assert.match(install.run, /bwrap --version/);
  assert.equal(reviewer.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1');
  assert.ok(!/CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0/.test(source));
  assert.equal(install.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test('official Claude Reviewer action allowlists only the trusted Publisher bot actor', () => {
  assert.equal(reviewer.with.allowed_bots, 'nexagnet-builder-publisher[bot]');
  assert.notEqual(reviewer.with.allowed_bots, '*');
  assert.equal(reviewer.with.allowed_non_write_users, undefined);
  assert.ok(preflight.includes('nexagnet-builder-publisher[bot]'));
  assert.ok(preflight.includes('.user.type == "Bot"'));
  assert.ok(preflight.includes('.head.sha == $sha'));
  assert.equal(jobs.review.permissions.contents, 'read');
  assert.equal(jobs.review.permissions['pull-requests'], 'read');
  assert.equal(jobs.review.permissions['id-token'], undefined);
  assert.ok(!JSON.stringify(jobs.review).includes('BUILDER_PUBLISHER_APP_PRIVATE_KEY'));
});

test('trusted Reviewer prepares bounded exact-base-to-head diff before Claude without sandbox Bash', () => {
  assert.equal(jobs.gate.outputs.base_sha, '${{ steps.verify.outputs.base_sha }}');
  assert.ok(preflight.includes('base_sha="$(jq -r .base.sha <<< "$pr")"'));
  assert.ok(preflight.includes('echo "base_sha=$base_sha"'));
  const steps = jobs.review.steps;
  const diff = steps.find(x => x.name === 'Prepare bounded trusted PR diff for read-only Claude');
  assert.ok(diff, 'trusted diff generator step must exist');
  assert.ok(steps.indexOf(diff) < steps.indexOf(steps.find(x => x.id === 'claude')));
  assert.equal(diff.env.BASE, '${{ needs.gate.outputs.base_sha }}');
  assert.equal(diff.env.HEAD_SHA, '${{ needs.gate.outputs.head }}');
  assert.match(diff.run, /test "\$\(git rev-parse HEAD\)" = "\$HEAD_SHA"/);
  assert.ok(diff.run.includes('git cat-file -e "${BASE}^{commit}"'));
  assert.ok(diff.run.includes('git diff --no-ext-diff --no-textconv "$BASE...$HEAD_SHA" --'));
  assert.ok(diff.run.includes('> "$RUNNER_TEMP/reviewer-pr-diff.patch"'));
  assert.ok(diff.run.includes('test -s "$RUNNER_TEMP/reviewer-pr-diff.patch"'));
  assert.ok(diff.run.includes('-le 500000'));
  assert.ok(reviewer.with.prompt.includes('reviewer-pr-diff.patch'));
  assert.ok(reviewer.with.prompt.includes('UNTRUSTED data'));
  assert.ok(reviewer.with.prompt.includes('diff_inspected=false'));
  assert.doesNotMatch(reviewer.with.claude_args, /Bash\(git /);
  assert.match(reviewer.with.claude_args, /--disallowedTools "Bash,/);
  assert.match(reviewer.with.claude_args, /"diff_inspected":\{"type":"boolean"\}/);
});

test('trusted Reporter is the only PR-comment writer and enforces diff inspection', () => {
  const run = jobs.report.steps[0].run;
  assert.equal(jobs.gate.permissions['pull-requests'], 'read');
  assert.equal(jobs.review.permissions['pull-requests'], 'read');
  assert.equal(jobs.report.permissions['pull-requests'], 'write');
  assert.equal(jobs.report.permissions.issues, 'read');
  assert.equal(jobs.report.permissions.contents, 'read');
  assert.equal(jobs.report.permissions['id-token'], undefined);
  assert.match(run, /\.diff_inspected \| type == "boolean"/);
  assert.match(run, /\.verdict == "PASS" then \.diff_inspected == true/);
  const artifactIndex = run.indexOf('> "$RUNNER_TEMP/review-evidence.json"');
  const commentIndex = run.indexOf('gh api -X POST "repos/$GITHUB_REPOSITORY/issues/$PR/comments"');
  assert.ok(artifactIndex >= 0 && commentIndex > artifactIndex, 'evidence assembled before publishing');
  assert.match(run, /jq -e --arg sha "\$SHA"/);
  assert.doesNotMatch(run, /gh pr merge|git push|repository_dispatch/);
  assert.ok(!JSON.stringify(jobs.review).includes('BUILDER_PUBLISHER_APP_PRIVATE_KEY'));
});
