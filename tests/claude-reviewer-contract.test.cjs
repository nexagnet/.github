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
  assert.match(reviewer.with.claude_args, /--disallowedTools "Edit,Write,/);
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

test('protected path gate includes workflow, automation and instruction file attacks', () => {
  const check = preflight.match(/jq -e 'all\(\.\[\];[\s\S]*?' <<< "\$files" >\/dev\/null/);
  assert.ok(check, 'Expected fail-closed protection applied to GitHub PR file listing');
  const regex = /test\("([^"]+)"\)/;
  const match = check[0].match(regex);
  assert.ok(match);
  const pattern = new RegExp(JSON.parse('"' + match[1].replace(/\\/g, '\\\\') + '"'.replace(/\\/g, '\\\\')));
  // Also assert directly on the jq expression; integration proof remains required.
  for(const name of ['.github', '.claude', 'infra/', 'deploy/', 'tools/autopilot/', 'agents', 'claude', 'mcp']) {
    assert.ok(check[0].toLowerCase().includes(name), 'missing guard for: ' + name);
  }
});

test('trusted reporter rechecks PR HEAD, Issue risk and CI run after Claude', () => {
  assert.deepEqual(jobs.report.needs, ['gate','review']);
  assert.equal(jobs.report.permissions.contents, 'read');
  assert.equal(jobs.report.permissions.issues, 'write');
  assert.equal(jobs.report.permissions['pull-requests'], 'read');
  assert.equal(jobs.report.permissions['id-token'], undefined);
  assert.match(reporter, /\.head\.sha == \$sha/);
  assert.match(reporter, /\.head_sha == \$sha/);
  assert.match(reporter, /risk:\$RISK/);
  assert.match(reporter, /REQUEST_CHANGES/);
  assert.match(reporter, /Not merge authorization/);
  assert.doesNotMatch(reporter, /gh pr merge|git push|repository_dispatch/);
});

test('every external action is pinned to 40-character immutable SHA', () => {
  const actions = [...source.matchAll(/uses: ([^\s]+)@([^\s]+)/g)];
  assert.ok(actions.length >= 2);
  for(const [, name, sha] of actions) {
    assert.match(sha, /^[0-9a-f]{40}$/, name);
  }
});
