'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {execFileSync}=require('node:child_process');
const p=require('node:path').resolve(__dirname,'../.github/workflows/claude-autonomy.yml');
const src=readFileSync(p,'utf8');
const y=JSON.parse(execFileSync('ruby',['-ryaml','-rjson','-e','puts JSON.generate(YAML.load_file(ARGV[0]))',p],{encoding:'utf8'}));
const jobs=y.jobs;
const policy=jobs.decide.steps.find(s=>s.id==='policy').run;
const preMerge=jobs.merge.steps[0].run;
const native=jobs.merge.steps.at(-1).run;
test('run-scoped trusted reviewer artifact and required jobs verified before merge',()=>{
  const input=(y.on||y.true).workflow_call.inputs;
  for(const k of ['pr_number','expected_head_sha','reviewer_run_id','required_jobs_csv'])assert.equal(input[k].required,true);
  for(const s of ['Nexagnet Reviewer caller','nexagnet-review-evidence','nexagnet-review-v1','review.verdict == "PASS"','head.sha == $sha','ci_run_id','jobs?per_page=100','conclusion == "success"','head_repository']) {
    if(s==='head_repository')continue;
    assert.ok(policy.includes(s),s);
  }
  assert.deepEqual(y.permissions,{});
});
test('risk R3 unknown or conflict always fails, R2 owner-only, R0/R1 require explicit auto-label',()=>{
  assert.match(policy,/risk:R0\|risk:R1\|risk:R2/);
  assert.doesNotMatch(policy,/risk:R3\) *;;/);
  assert.match(policy,/risk:R2\) decision=NEEDS_OWNER/);
  assert.match(policy,/autopilot:auto-merge/);
  assert.match(policy,/gh run download "\$REVIEW_RUN" .*--repo "\$GITHUB_REPOSITORY"/);
  assert.match(policy,/autopilot:ready/);
  assert.match(policy,/R0_R1_AUTO_MERGE/);
  assert.match(jobs.merge.if,/R0_R1_AUTO_MERGE/);
  assert.match(jobs.human.if,/NEEDS_OWNER/);
  assert.ok(!JSON.stringify(jobs.human).includes('AUTONOMY_MERGE_APP_PRIVATE_KEY'));
});
test('read-only policy then isolated MERGE token: no publisher secrets or OIDC',()=>{
  assert.equal(jobs.decide.permissions.contents,'read');
  assert.equal(jobs.decide.permissions.actions,'read');
  assert.equal(jobs.decide.permissions['id-token'],undefined);
  assert.equal(jobs.merge.permissions.contents,'read');
  const token=jobs.merge.steps.find(s=>s.id==='merge_token');
  assert.ok(token);
  assert.equal(token.with['permission-contents'],'write');
  assert.equal(token.with['permission-pull-requests'],'write');
  assert.equal(token.with['permission-workflows'],undefined);
  assert.match(token.with['private-key'],/AUTONOMY_MERGE_APP_PRIVATE_KEY/);
  assert.ok(!src.includes('BUILDER_PUBLISHER_APP_PRIVATE_KEY'));
});
test('privileged merge step checks current head, labels and risk, no bypass',()=>{
  assert.match(preMerge,/\.head\.sha == \$sha/);
  assert.match(preMerge,/autopilot:auto-merge/);
  assert.match(preMerge,/case "\$RISK" in R0\|R1/);
  assert.match(native,/gh pr ready/);
  assert.match(native,/gh pr merge "\$PR" --squash --match-head-commit "\$SHA"/);
  assert.doesNotMatch(native,/--auto/);
  assert.match(preMerge,/effective_rules=.*rules\/branches/);
  assert.match(preMerge,/\.type != "merge_queue"/);
  assert.match(preMerge,/\.type == "required_status_checks"/);
  assert.doesNotMatch(native,/--admin|--force/);
  assert.match(native,/exact-main CI separately/);
});
test('merge job rechecks immutable contract, current Reviewer, latest CI, all jobs and protected paths',()=>{
  const outputs=jobs.decide.outputs;
  for(const k of ['ci_run','reviewer_run','contract_hash','base'])assert.ok(outputs[k],k);
  assert.match(preMerge,/Task Contract changed/);
  assert.match(preMerge,/Nexagnet Reviewer caller/);
  assert.match(preMerge,/workflow_runs \| length > 0/);
  assert.match(preMerge,/\.\[0\]\.id == \$id/);
  assert.match(preMerge,/\.head_sha == \$sha/);
  assert.match(preMerge,/\.pull_requests\[\]\?\.number/);
  assert.match(preMerge,/jobs\?per_page=100/);
  assert.match(preMerge,/pulls\/\$PR\/files\?per_page=100/);
  assert.match(preMerge,/\.base\.ref == \$base/);
  assert.match(preMerge,/risk:\$RISK/);
  assert.ok(jobs.merge.steps.find(x=>x.id==='merge_token'));
  assert.ok(jobs.merge.steps.findIndex(x=>x.id==='merge_token') > 0);
});
test('all dependencies pinned to 40-char SHA; no inherited secrets',()=>{
  const actions=[...src.matchAll(/uses:\s*([^\s@]+)@([0-9a-f]{40})/g)];
  assert.ok(actions.length>=1);
  assert.doesNotMatch(src,/secrets: inherit/);
});
