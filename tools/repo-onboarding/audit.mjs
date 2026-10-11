#!/usr/bin/env node
// R3 Issue #5: read-only organization repository discovery.
// No token with workflow/write permissions is ever used here.
import { writeFileSync, appendFileSync } from 'node:fs';

export const OWNER = 'nexagnet';
export const CALLERS = Object.freeze([
  '.github/workflows/nexagnet-claude-builder.yml',
  '.github/workflows/nexagnet-claude-reviewer.yml',
]);
export const CI_PATH = '.github/workflows/ci.yml';

export function selectConsumer(repo) {
  if (!repo || repo.owner?.login !== OWNER) return false;
  if (repo.name === '.github') return false;
  if (repo.archived || repo.disabled || repo.is_template) return false;
  if (repo.fork) return false;
  return true;
}
export function statusFor({repo, paths, access}) {
  if (!selectConsumer(repo)) return 'SKIPPED_OR_OUT_OF_SCOPE';
  if (access !== 'READABLE') return 'UNKNOWN_ACCESS_NO_CONCLUSION';
  if (paths.includes(CI_PATH) && CALLERS.every(p => paths.includes(p))) {
    return 'CALLER_FILES_PRESENT_NOT_RUNTIME_PROVEN';
  }
  return 'NEEDS_R3_BOOTSTRAP_PR';
}
export function uniqueByFullName(repos) {
  const out = new Map();
  for (const r of repos) {
    if (!r?.full_name || out.has(r.full_name)) continue;
    out.set(r.full_name, r);
  }
  return [...out.values()];
}

const root = 'https://api.github.com';
export async function requestJson(route, token, fetchFn = fetch) {
  if (!route.startsWith('/')) throw new Error('Only relative GitHub REST paths');
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'nexagnet-central-repo-audit',
  };
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetchFn(root + route, {headers});
  if (response.status === 404) return {status:404, data:null};
  if (!response.ok) throw new Error('GitHub REST request failed: HTTP ' + response.status + ' (' + route + ')');
  return {status:200, data:await response.json()};
}

export async function discoverOrgRepos(token, request = requestJson) {
  const all = [];
  for (let page=1; page<=10; page++) {
    const route = '/orgs/' + OWNER + '/repos?type=all&per_page=100&page=' + page;
    const {status,data} = await request(route,token);
    if (status !== 200 || !Array.isArray(data)) throw new Error('Organization repositories not available');
    all.push(...data);
    if (data.length < 100) return uniqueByFullName(all);
  }
  throw new Error('Pagination ceiling reached; refusing incomplete discovery');
}
export async function inspectRepo(repo, token, request = requestJson) {
  if (!selectConsumer(repo)) return {repository:repo.full_name,status:'SKIPPED_OR_OUT_OF_SCOPE',paths:[]};
  const paths = [];
  for (const path of [CI_PATH, ...CALLERS]) {
    const route = '/repos/' + OWNER + '/' + repo.name + '/contents/' + path;
    try {
      const {status} = await request(route,token);
      if (status === 200) paths.push(path);
      else if (status !== 404) throw new Error('Unexpected status ' + status);
    } catch(e) {
      return {repository:repo.full_name,status:'UNKNOWN_ACCESS_NO_CONCLUSION',paths,error:String(e.message)};
    }
  }
  return {repository:repo.full_name,paths,status:statusFor({repo,paths,access:'READABLE'})};
}

async function main() {
  const token=process.env.GH_TOKEN || '';
  const repos=await discoverOrgRepos(token);
  const items=[];
  for(const repo of repos) items.push(await inspectRepo(repo,token));
  const summary={
    organization: OWNER,
    observed_at: new Date().toISOString(),
    coverage: 'GITHUB_TOKEN_VISIBLE_ONLY_NOT_GUARANTEED_PRIVATE_OR_ALL_REPOS',
    caller_file_presence_is_not_runtime_proof: true,
    repo_count:repos.length,
    items,
  };
  const json=JSON.stringify(summary,null,2)+'\n';
  writeFileSync('onboarding-discovery.json',json);
  let markdown='## Nexagnet repository discovery (R3, read-only)\n\n';
  markdown+='**Coverage limitation:** only repositories visible to this workflow token. ';
  markdown+='Future/private repositories may require separate owner-approved read-only GitHub App access.\n\n';
  markdown+='| Repository | File audit result |\n|---|---|\n';
  for(const item of items) markdown+='| '+item.repository+' | '+item.status+' |\n';
  markdown+='\n**NEEDS_R3_BOOTSTRAP_PR does not automatically authorize writing workflow files.**\n';
  if(process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,markdown);
  console.log(json);
}
if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  main().catch(e=>{console.error('::error::'+e.message);process.exitCode=1;});
}
