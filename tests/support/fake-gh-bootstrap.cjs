#!/usr/bin/env node
'use strict';
// Fake `gh api` có trạng thái cho test scripts/bootstrap-repo.sh. Chỉ dữ liệu giả.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const dir = process.env.FAKE_GH_DIR;
const statePath = `${dir}/state.json`;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
if (args[0] !== 'api') { process.stderr.write('unknown gh invocation\n'); process.exit(2); }
const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET';
const jqExpr = args.includes('--jq') ? args[args.indexOf('--jq') + 1] : null;
const route = args.slice(1).find((a) => !a.startsWith('-') && (a.startsWith('repos/') || a.startsWith('orgs/') || a === 'user'));
const fields = {};
for (let i = 1; i < args.length; i++) {
  if ((args[i] === '-f' || args[i] === '-F') && args[i + 1]) {
    const eq = args[i + 1].indexOf('=');
    let v = args[i + 1].slice(eq + 1);
    if (args[i] === '-F' && (v === 'true' || v === 'false')) v = v === 'true';
    fields[args[i + 1].slice(0, eq)] = v;
  }
}
let body = null;
if (args.includes('--input')) { body = JSON.parse(fs.readFileSync(0, 'utf8')); Object.assign(fields, body); }
fs.appendFileSync(`${dir}/calls.log`, `${method} ${route}\n`);

const out = (value) => {
  const text = JSON.stringify(value);
  if (jqExpr) {
    const r = spawnSync('jq', ['-r', jqExpr], { input: text, encoding: 'utf8' });
    if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(1); }
    process.stdout.write(r.stdout);
  } else process.stdout.write(text + '\n');
};
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const notFound = () => { process.stderr.write('gh: Not Found (HTTP 404)\n'); process.exit(1); };
const R = (state.repo);
const base = `repos/${R}`;
const path = route.split('?')[0];
let m;

if (route === 'user') out({ login: state.user });
else if (path === 'repos/nexagnet/.github') out({ default_branch: 'main' });
else if (path === 'repos/nexagnet/.github/commits/main') out({ sha: 'd'.repeat(40) });
else if (path.startsWith('repos/nexagnet/.github/contents/')) { (state.central || []).includes(path.split('/contents/')[1]) ? out({}) : notFound(); }
else if (path.startsWith('orgs/')) { process.stderr.write('gh: forbidden (HTTP 403)\n'); process.exit(1); }
else if (path === base && method === 'GET') out({ default_branch: 'main' });
else if (path === base && method === 'PATCH') { state.settings = fields; save(); out({}); }
else if ((m = path.match(new RegExp(`^${base}/labels/(.+)$`)))) {
  if (method === 'GET') { state.labels[m[1]] ? out(state.labels[m[1]]) : notFound(); }
  else { state.labels[m[1]] = { ...state.labels[m[1]], ...fields }; save(); out({}); }
} else if (path === `${base}/labels` && method === 'POST') { state.labels[fields.name] = fields; save(); out({}); }
else if ((m = path.match(new RegExp(`^${base}/contents/(.+)$`)))) {
  if (method === 'GET') {
    const ref = (route.split('ref=')[1] || '');
    const key = `${ref}:${m[1]}`;
    state.files[key] !== undefined ? out({ path: m[1] }) : notFound();
  } else { state.files[`${fields.branch}:${m[1]}`] = Buffer.from(fields.content, 'base64').toString('utf8'); save(); out({}); }
} else if (path.startsWith(`${base}/git/ref/heads/`)) {
  const name = path.split('/heads/')[1];
  state.refs[name] ? out({ object: { sha: state.refs[name] } }) : notFound();
} else if (path === `${base}/git/refs` && method === 'POST') { state.refs[fields.ref.replace('refs/heads/', '')] = fields.sha; save(); out({}); }
else if (path === `${base}/pulls` && method === 'GET') out(state.pulls);
else if (path === `${base}/pulls` && method === 'POST') {
  state.pulls.push({ number: state.pulls.length + 1, title: fields.title, head: fields.head, html_url: `https://github.com/${R}/pull/${state.pulls.length + 1}`, body: fields.body });
  save(); out(state.pulls[state.pulls.length - 1]);
} else if (path === `${base}/rulesets` && method === 'GET') out(state.rulesets);
else if (path === `${base}/rulesets` && method === 'POST') { state.rulesets.push({ id: 7, ...body }); save(); out({}); }
else if ((m = path.match(new RegExp(`^${base}/rulesets/(\\d+)$`))) && method === 'PUT') {
  state.rulesets = state.rulesets.map((r) => (String(r.id) === m[1] ? { id: r.id, ...body } : r)); save(); out({});
} else { process.stderr.write(`UNEXPECTED ${method} ${route}\n`); process.exit(97); }
