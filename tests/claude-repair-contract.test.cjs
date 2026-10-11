'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {execFileSync,spawnSync}=require('node:child_process');
const path=require('node:path');
const filename=path.resolve(__dirname,'../.github/workflows/claude-repair.yml');
const source=readFileSync(filename,'utf8');
const y=JSON.parse(execFileSync('ruby',['-ryaml','-rjson','-e','puts JSON.generate(YAML.load_file(ARGV[0]))',filename],{encoding:'utf8'}));
const caller=(y.on||y.true).workflow_call;
const gate=y.jobs.gate.steps.find(x=>x.id==='check').run;
const agent=y.jobs.agent;
const pub=y.jobs.publish;
const guard=pub.steps.find(x=>x.name?.startsWith('Verify patch')).run;
const push=pub.steps.at(-1).run;

test('requires trusted Reviewer workflow run, exact SHA and structured evidence',()=>{
  for(const name of ['pr_number','expected_head_sha','reviewer_run_id'])assert.equal(caller.inputs[name].required,true);
  for(const name of ['CLAUDE_CODE_OAUTH_TOKEN','BUILDER_PUBLISHER_APP_ID','BUILDER_PUBLISHER_APP_PRIVATE_KEY'])assert.equal(caller.secrets[name].required,true);
  assert.deepEqual(y.permissions,{});
  for(const phrase of ['Nexagnet Reviewer caller','nexagnet-claude-reviewer.yml','nexagnet-review-evidence','nexagnet-review-v1','REQUEST_CHANGES','head.sha == $sha','nexagnet-builder-publisher[bot]']) {
    assert.ok(gate.includes(phrase),phrase);
  }
});
test('bounded two attempts and PR-scoped concurrency',()=>{
  assert.match(gate,/repair: validated issue/);
  assert.match(gate,/test "\$count" -lt 2/);
  assert.match(y.concurrency.group,/nexagnet-repair-/);
  assert.equal(y.concurrency['cancel-in-progress'],false);
});
test('untrusted Claude lacks Publisher credentials, OIDC and GitHub write',()=>{
  assert.equal(agent.permissions.contents,'read');
  assert.equal(agent.permissions['pull-requests'],'read');
  assert.equal(agent.permissions['id-token'],undefined);
  assert.ok(!JSON.stringify(agent).includes('BUILDER_PUBLISHER_APP_PRIVATE_KEY'));
  const step=agent.steps.find(x=>x.name?.startsWith('Repair locally'));
  assert.equal(step.with.github_token,'${{ github.token }}');
  assert.match(step.with.claude_args,/--disallowedTools "Bash,WebFetch,WebSearch"/);
  assert.match(step.with.prompt,/trusted-review\.json/);
});
test('clean publisher validates untrusted patch before minting limited App token',()=>{
  assert.deepEqual(pub.needs,['gate','agent']);
  assert.equal(pub.permissions.contents,'read');
  const g=pub.steps.findIndex(x=>x.name?.startsWith('Verify patch'));
  const t=pub.steps.findIndex(x=>x.id==='publisher');
  assert.ok(t>g);
  assert.match(guard,/git apply --check --index/);
  assert.match(guard,/autopilot:ready/);
  assert.match(guard,/\.head\.sha == \$sha/);
  assert.match(guard,/\.head\.ref == \$branch/);
  assert.equal(pub.steps[t].with['permission-contents'],'write');
  assert.equal(pub.steps[t].with['permission-pull-requests'],'write');
  assert.equal(pub.steps[t].with['permission-workflows'],undefined);
});
test('Repair invalidates stale Task Contract and retargeted PR base',()=>{
  assert.match(gate,/contract_hash=.*sha256sum/);
  assert.match(gate,/\.base\.ref == \$base/);
  assert.match(guard,/Task Contract changed/);
  assert.match(guard,/\.base\.ref == \$base/);
  assert.ok(pub.steps.find(s=>s.name?.startsWith('Verify patch')).env.CONTRACT_HASH);
});
test('same PR fast-forward only, never merge or force',()=>{
  assert.match(push,/git push origin "HEAD:refs\/heads\/\$BRANCH"/);
  assert.doesNotMatch(push,/--force|gh pr merge|pulls\/.*\/merge/);
});
test('reject protected paths case-insensitively and special git modes',()=>{
  const start=guard.indexOf('p="$(printf');
  const end=guard.indexOf('esac',start);
  assert.ok(start>=0&&end>start);
  const snippet=guard.slice(start,end+4);
  function accept(file){const p=spawnSync('bash',['-c','set -e\nname="$1"\n'+snippet,'test',file],{encoding:'utf8'});return p.status===0}
  for(const name of ['.github/x.yml','nested/.github/x','.claude/settings.json','tools/autopilot/a.mjs','infra/a','deploy/a','src/.env','.npmrc','AGENTS.md','private.pem'])assert.equal(accept(name),false,name);
  for(const name of ['src/a.ts','tests/new.spec.ts','docs/readme.md'])assert.equal(accept(name),true,name);
  assert.match(guard,/100644\|100755/);
});
test('third party actions pinned and no secrets inheritance',()=>{
  const pinned=[...source.matchAll(/uses:\s*([^\s@]+)@([a-f0-9]{40})/g)];
  assert.ok(pinned.length>=4);
  assert.doesNotMatch(source,/secrets: inherit/);
});
