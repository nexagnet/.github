import {test} from 'node:test';
import assert from 'node:assert/strict';
import {issueMarker,issueTitle,shouldPropose,contract,reconcile,createCentralTrackingIssue} from './plan.mjs';

const row=(name)=>({repository:'nexagnet/'+name,status:'NEEDS_R3_BOOTSTRAP_PR'});
const repo=(name)=>({
  name,
  full_name:'nexagnet/'+name,
  owner:{login:'nexagnet'},
  archived:false,disabled:false,is_template:false,fork:false
});
const request=async(route,token)=>{
  if(route==='/repos/nexagnet/.github/issues?state=all&per_page=100&page=1')return{status:200,data:[]};
  if(route.includes('/issues?state=all'))return{status:200,data:[]};
  if(route.startsWith('/repos/nexagnet/'))return{status:200,data:repo(route.split('/')[3])};
  throw Error('Unexpected request: '+route);
};

test('task markers have deterministic repository identity',()=>{
  assert.equal(issueMarker('nexagnet/sample'),'<!-- nexagnet-auto-onboarding: nexagnet/sample -->');
  assert.match(issueTitle('nexagnet/sample'),/R3/);
  assert.match(contract('nexagnet/sample'),/## OBJECTIVE/);
  assert.match(contract('nexagnet/sample'),/## STOP CONDITIONS/);
  assert.match(contract('nexagnet/sample'),/Never overwrite|Never overwrite/i);
});

test('never create a central control-plane or outside-org Issue',()=>{
  assert.equal(shouldPropose(row('.github')),false);
  assert.equal(shouldPropose({repository:'foreign/name',status:'NEEDS_R3_BOOTSTRAP_PR'}),false);
  assert.equal(shouldPropose({repository:'nexagnet/x',status:'UNKNOWN_ACCESS_NO_CONCLUSION'}),false);
});

test('dedupe against trusted central and consumer Issue evidence',()=>{
  assert.equal(shouldPropose(row('sample'),[{body:issueMarker('nexagnet/sample')}]),false);
  assert.equal(shouldPropose(row('sample'),[],[{title:'[R3] Roll out shared Nexagnet Claude Builder/Reviewer caller'}]),false);
  assert.equal(shouldPropose(row('sample'),[],[]),true);
});

test('idempotent reconciliation creates just one canonical tracking Issue per repo',async()=>{
  const created=[];
  const mockCreate=async(name)=>{
    created.push(name);
    return 'https://github.com/nexagnet/.github/issues/123';
  };
  const result=await reconcile([row('new'),row('new'),row('.github')], 'test',request,mockCreate);
  assert.deepEqual(created,['nexagnet/new']);
  assert.deepEqual(result.map(x=>x.status),['CREATED_R3_TRACKING_ISSUE','ALREADY_TRACKED']);
});

test('stale/missing repo and hidden consumer Issues fail closed',async()=>{
  const unavailable=async(route,token)=>{
    if(route.includes('/.github/issues'))return{status:200,data:[]};
    if(route==='/repos/nexagnet/new')return{status:404,data:null};
    throw Error('Unexpected route');
  };
  const created=[];
  const result=await reconcile([row('new')], 'test',unavailable,async r=>{created.push(r);return 'url';});
  assert.equal(result[0].status,'SKIPPED_ACCESS_OR_REPO_NOT_ELIGIBLE');
  assert.deepEqual(created,[]);
});

test('central tracking writer may only call central GitHub Issues API',async()=>{
  let called=false;
  const fake=async(url,opts)=>{
    called=true;
    assert.equal(url,'https://api.github.com/repos/nexagnet/.github/issues');
    assert.equal(opts.method,'POST');
    assert.equal(opts.headers.Authorization,'Bearer TEST');
    const payload=JSON.parse(opts.body);
    assert.deepEqual(payload.labels,['risk:R3']);
    assert.match(payload.body,/## RUNTIME PROOF/);
    return{ok:true,json:async()=>({html_url:'https://github.com/nexagnet/.github/issues/17'})};
  };
  assert.equal(await createCentralTrackingIssue('nexagnet/new','TEST',fake),
    'https://github.com/nexagnet/.github/issues/17');
  assert.equal(called,true);
});
