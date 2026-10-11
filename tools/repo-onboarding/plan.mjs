#!/usr/bin/env node
// R3 Issue #5: trusted coordinator job ONLY, no source code writes.
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {selectConsumer,requestJson} from './audit.mjs';

const CENTRAL='nexagnet/.github';
const MARKER='nexagnet-auto-onboarding: ';
const ONBOARD_LINK='https://github.com/nexagnet/.github/issues/5';

export const issueTitle = repo => '[R3] Bootstrap shared AI workflows — ' + repo;
export const issueMarker = repo => '<!-- '+MARKER+repo+' -->';

export function shouldPropose(row, existingCentral=[], existingConsumer=[]) {
  if (!row || row.status !== 'NEEDS_R3_BOOTSTRAP_PR') return false;
  if (typeof row.repository !== 'string' || !/^nexagnet\/[A-Za-z0-9_.-]+$/.test(row.repository)) return false;
  if (row.repository === CENTRAL) return false;
  if (existingCentral.some(i=>String(i.body||'').includes(issueMarker(row.repository)))) return false;
  if (existingConsumer.some(i => !i.pull_request &&
    /roll out shared nexagnet|bootstrap shared ai workflows|auto.?onboard/i.test(i.title||''))) return false;
  return true;
}
export async function listIssues(repo,token,request=requestJson) {
  const out=[];
  for(let page=1;page<=10;page++){
    const route='/repos/'+repo+'/issues?state=all&per_page=100&page='+page;
    const result=await request(route,token);
    if(result.status!==200||!Array.isArray(result.data))
      throw Error('Cannot verify current issues for '+repo);
    out.push(...result.data);
    if(result.data.length<100)return out;
  }
  throw Error('Issue list may be incomplete for '+repo);
}
export function contract(repo) {
  return [
    issueMarker(repo),
    '## OBJECTIVE',
    'Bootstrap Nexagnet shared Claude engineering workflow safely into '+repo+'.',
    'Parent: '+ONBOARD_LINK,
    'Coordinator: https://github.com/nexagnet/nexagnet-platform/issues/447',
    '## SCOPE',
    'Audit live default branch, existing CI/V4 and ruleset. Propose R3 Draft PR for SHA-pinned Builder/Reviewer/Repair/Autonomy caller and appropriate CI. Never overwrite existing workflows. Prove exact-head CI, owner merge, exact-main CI and synthetic runtime.',
    '## OUT OF SCOPE',
    'No customer data, production deploy, secret changes, automatic R3 merge, App permission changes or deletion of V4.',
    '## ACCEPTANCE',
    'Reviewed full-SHA central caller, no conflicting V4 executions, required CI matching the repo tech stack, valid risk gates, owner-approved R3 bootstrap merge and end-to-end smoke evidence.',
    '## RISK',
    'R3 — workflow/control-plane; NEVER set autopilot:ready.',
    '## RUNTIME PROOF',
    'Real GitHub Issue -> Builder Draft PR -> exact-head CI -> independent Reviewer, Repair if needed -> gated merge -> exact-main CI on a disposable nonproduction task.',
    '## STOP CONDITIONS',
    'Stop for workflow write permission, App/secret/ruleset changes, customer data, production, wrong repository, stale SHA or missing owner merge approval.',
    '',
  ].join('\n\n');
}
export async function createCentralTrackingIssue(repo,token,fetchFn=fetch) {
  const url='https://api.github.com/repos/'+CENTRAL+'/issues';
  const response=await fetchFn(url,{
    method:'POST',
    headers:{
      Authorization:'Bearer '+token,
      Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28',
      'Content-Type':'application/json',
      'User-Agent':'nexagnet-onboarding-tracker',
    },
    body:JSON.stringify({title:issueTitle(repo),body:contract(repo),labels:['risk:R3']})
  });
  if(!response.ok)throw Error('Cannot create R3 tracking Issue: HTTP '+response.status);
  const data=await response.json();
  return data.html_url;
}

export async function reconcile(rows,token,request=requestJson,create=createCentralTrackingIssue) {
  const existing=await listIssues(CENTRAL,token,request);
  const actions=[];
  for(const row of rows){
    if(row.status!=='NEEDS_R3_BOOTSTRAP_PR')continue;
    const name=row.repository;
    if(typeof name!=='string'||!/^nexagnet\/[A-Za-z0-9_.-]+$/.test(name) || name===CENTRAL)continue;
    const rest=await request('/repos/'+name,token);
    if(rest.status!==200||!selectConsumer(rest.data)) {
      actions.push({repo:name,status:'SKIPPED_ACCESS_OR_REPO_NOT_ELIGIBLE'});
      continue;
    }
    let consumer=[];
    try {consumer=await listIssues(name,token,request);}
    catch {actions.push({repo:name,status:'BLOCKED_CANNOT_VALIDATE_EXISTING_ISSUES'});continue;}
    if(!shouldPropose(row,existing,consumer)){
      actions.push({repo:name,status:'ALREADY_TRACKED'});
      continue;
    }
    const url=await create(name,token);
    existing.push({body:issueMarker(name),html_url:url});
    actions.push({repo:name,status:'CREATED_R3_TRACKING_ISSUE',url});
  }
  return actions;
}
async function main(){
  const token=process.env.GH_TOKEN;
  if(!token)throw Error('Missing GitHub token');
  const report=JSON.parse(readFileSync('onboarding-discovery.json','utf8'));
  if(report.organization!=='nexagnet'||!Array.isArray(report.items))throw Error('Malformed discovery evidence');
  if(report.items.length>1000)throw Error('Too many repos in input');
  const actions=await reconcile(report.items,token);
  writeFileSync('onboarding-tracking.json',JSON.stringify(actions,null,2)+'\n');
  if(process.env.GITHUB_STEP_SUMMARY){
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      '\n## R3 onboarding issue tracking\n'+actions.map(x=>'- '+x.repo+': '+x.status).join('\n')+'\n');
  }
  console.log(JSON.stringify(actions));
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
  main().catch(e=>{console.error('::error::'+e.message);process.exitCode=1;});
}
