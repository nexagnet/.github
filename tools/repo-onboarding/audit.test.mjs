import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  OWNER,CALLERS,CI_PATH,selectConsumer,statusFor,uniqueByFullName,
  discoverOrgRepos,inspectRepo,requestJson
} from './audit.mjs';

const repo = (name, extras={}) => ({
  full_name: OWNER+'/'+name,
  name,
  owner:{login:OWNER},
  archived:false,disabled:false,fork:false,is_template:false,
  ...extras,
});

test('ignore control plane, archived, forks, templates and wrong organization', () => {
  assert.equal(selectConsumer(repo('.github')),false);
  assert.equal(selectConsumer(repo('old',{archived:true})),false);
  assert.equal(selectConsumer(repo('fork',{fork:true})),false);
  assert.equal(selectConsumer(repo('template',{is_template:true})),false);
  assert.equal(selectConsumer(repo('app',{owner:{login:'other'}})),false);
  assert.equal(selectConsumer(repo('app')),true);
});

test('files present does not mean runtime-proven', () => {
  assert.equal(statusFor({repo:repo('x'),paths:[CI_PATH,...CALLERS],access:'READABLE'}),
    'CALLER_FILES_PRESENT_NOT_RUNTIME_PROVEN');
  assert.equal(statusFor({repo:repo('x'),paths:[],access:'READABLE'}),'NEEDS_R3_BOOTSTRAP_PR');
  assert.equal(statusFor({repo:repo('x'),paths:[],access:'NO_PERMISSION'}),
    'UNKNOWN_ACCESS_NO_CONCLUSION');
  assert.equal(statusFor({repo:repo('.github'),paths:[],access:'READABLE'}),
    'SKIPPED_OR_OUT_OF_SCOPE');
});

test('repo de-duplication is idempotent',()=>{
  const actual=uniqueByFullName([repo('a'),repo('a'),repo('b')]);
  assert.deepEqual(actual.map(x=>x.name),['a','b']);
});

test('discovery paginates and never silently truncates', async()=>{
  let calls=0;
  const first=Array.from({length:100},(_,i)=>repo('repo-'+i));
  const request=async()=>({status:200,data:++calls===1?first:[repo('more')]});
  const result=await discoverOrgRepos('testing',request);
  assert.equal(result.length,101);
  assert.equal(calls,2);
  await assert.rejects(discoverOrgRepos('test',async()=>({status:200,data:first})),
    /Pagination ceiling reached/);
});

test('discovery fails closed if organization visibility is missing',async()=>{
  await assert.rejects(discoverOrgRepos('test',async()=>({status:403,data:null})),
    /not available/);
});

test('readonly audit distinguishes missing files vs missing access',async()=>{
  const r=repo('example');
  const missing=await inspectRepo(r,'t',async()=>({status:404,data:null}));
  assert.equal(missing.status,'NEEDS_R3_BOOTSTRAP_PR');
  const forbidden=await inspectRepo(r,'t',async()=>{throw Error('Forbidden');});
  assert.equal(forbidden.status,'UNKNOWN_ACCESS_NO_CONCLUSION');
  const ready=await inspectRepo(r,'t',async()=>({status:200,data:{}}));
  assert.equal(ready.status,'CALLER_FILES_PRESENT_NOT_RUNTIME_PROVEN');
});

test('GitHub requests use only relative HTTPS GitHub API paths',async()=>{
  let lastUrl='';
  const mock=async(url,options)=>{lastUrl=url;assert.equal(options.headers.Authorization,'Bearer sample');return{ok:true,status:200,json:async()=>({ok:true})}};
  const a=await requestJson('/repos/nexagnet/example','sample',mock);
  assert.equal(a.status,200);
  assert.equal(lastUrl,'https://api.github.com/repos/nexagnet/example');
  await assert.rejects(requestJson('https://attacker.example/','token',mock),/Only relative/);
});
