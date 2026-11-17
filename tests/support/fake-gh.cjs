#!/usr/bin/env node
'use strict';
// Fake `gh api` for Builder trust-boundary tests. Synthetic data only.
// Static mode : pages from comments-N.json / pulls-N.json. `--paginate` returns every page
//               as concatenated JSON arrays (like gh); without it ONLY page 1 (like gh's default).
// Dynamic mode: if pulls-state.json exists, PRs are a shared, locked store (race tests).
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const dir = process.env.FAKE_GH_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(`${dir}/calls.log`, args.join(' ') + '\n');

const die = (message, code = 1) => { process.stderr.write(message + '\n'); process.exit(code); };
const failing = (process.env.FAKE_GH_FAIL || '').split(',').filter(Boolean);
const read = (name) => fs.readFileSync(`${dir}/${name}`, 'utf8');
const exists = (name) => fs.existsSync(`${dir}/${name}`);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (args[0] === 'auth' && args[1] === 'setup-git') process.exit(0);
if (args[0] !== 'api') die('unknown gh invocation: ' + args.join(' '), 2);
const paginate = args.includes('--paginate');
const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
const jqIndex = args.indexOf('--jq');
const jqExpr = jqIndex >= 0 ? args[jqIndex + 1] : null;
const route = args.find((a) => a.startsWith('repos/'));
if (!route) die('missing route', 2);
const fields = {};
for (let i = 1; i < args.length; i++) {
  if ((args[i] === '-f' || args[i] === '-F') && args[i + 1]) {
    const eq = args[i + 1].indexOf('=');
    fields[args[i + 1].slice(0, eq)] = args[i + 1].slice(eq + 1);
  }
}

if (args.includes('--input')) Object.assign(fields, JSON.parse(fs.readFileSync(0, 'utf8')));

function emit(text) {
  if (jqExpr) {
    const r = spawnSync('jq', ['-r', jqExpr], { input: text, encoding: 'utf8' });
    if (r.status !== 0) die('jq failed: ' + r.stderr);
    process.stdout.write(r.stdout);
  } else {
    process.stdout.write(text.endsWith('\n') ? text : text + '\n');
  }
}

function pages(prefix) {
  const out = [];
  for (let n = 1; exists(`${prefix}-${n}.json`); n++) out.push(read(`${prefix}-${n}.json`).trim());
  if (out.length === 0) out.push('[]');
  return paginate ? out.join('\n') : out[0];
}

function withLock(fn) {
  const lock = `${dir}/state.lock`;
  const started = Date.now();
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() - started > 10000) die('lock timeout');
      sleep(3);
    }
  }
  try { return fn(); } finally { fs.rmdirSync(lock); }
}

function barrier() {
  const flow = process.env.FLOW_ID;
  const need = Number(process.env.BARRIER_N || 0);
  if (!flow || !need || exists(`barrier-${flow}`)) return;
  fs.writeFileSync(`${dir}/barrier-${flow}`, '');
  const started = Date.now();
  while (fs.readdirSync(dir).filter((f) => f.startsWith('barrier-')).length < need) {
    if (Date.now() - started > 15000) die('barrier timeout');
    sleep(3);
  }
}

let m;
if (/^repos\/[^/]+\/[^/]+$/.test(route) && jqExpr === '.default_branch') {
  process.stdout.write('main\n');
} else if (/^repos\/[^/]+\/[^/]+\/branches\/main$/.test(route)) {
  process.stdout.write('a'.repeat(40) + '\n');
} else if (/^repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(route)) {
  emit(read('issue.json'));
} else if (/^repos\/[^/]+\/[^/]+\/issues\/comments\/\d+$/.test(route)) {
  if (failing.includes('live')) die('HTTP 403');
  emit(read('live-comment.json'));
} else if (/^repos\/[^/]+\/[^/]+\/issues\/\d+\/comments\?/.test(route)) {
  if (failing.includes('comments')) die('HTTP 403: rate limit exceeded');
  emit(pages('comments'));
} else if (/^repos\/[^/]+\/[^/]+\/pulls\?/.test(route)) {
  if (failing.includes('pulls')) die('HTTP 403: rate limit exceeded');
  if (failing.includes('pulls-garbage')) { process.stdout.write('<html>not json</html>\n'); process.exit(0); }
  if (exists('pulls-state.json')) {
    barrier();
    emit(withLock(() => JSON.stringify(JSON.parse(read('pulls-state.json')).prs)));
  } else {
    emit(pages('pulls'));
  }
} else if (/^repos\/[^/]+\/[^/]+\/pulls$/.test(route) && method === 'GET') {
  if (failing.includes('holder')) die('HTTP 403');
  const branch = fields.head.slice(fields.head.indexOf(':') + 1);
  const prs = exists('pulls-state.json') ? JSON.parse(read('pulls-state.json')).prs
    : JSON.parse(read('pulls-1.json'));
  emit(JSON.stringify(prs.filter(pr => pr.head.ref === branch)));
} else if (/^repos\/[^/]+\/[^/]+\/git\/commits$/.test(route) && method === 'POST') {
  if (failing.includes('commit')) die('HTTP 500');
  const commit = withLock(() => {
    const commits = exists('commits-state.json') ? JSON.parse(read('commits-state.json')) : {};
    const sha = require('node:crypto').createHash('sha1').update(JSON.stringify(fields)).digest('hex');
    const value = { sha, message: fields.message, tree: { sha: fields.tree }, parents: fields.parents.map(sha => ({ sha })) };
    commits[sha] = value; fs.writeFileSync(`${dir}/commits-state.json`, JSON.stringify(commits));
    return value;
  });
  emit(JSON.stringify(commit));
} else if ((m = route.match(/^repos\/[^/]+\/[^/]+\/git\/commits\/([0-9a-f]{40})$/)) && method === 'GET') {
  if (failing.includes('commit-get')) die('HTTP 403');
  const commits = exists('commits-state.json') ? JSON.parse(read('commits-state.json')) : {};
  const value = commits[m[1]] || (m[1] === 'a'.repeat(40) ? { sha: m[1], tree: { sha: 'b'.repeat(40) }, parents: [], message: 'base' } : null);
  if (!value) die('HTTP 404');
  emit(JSON.stringify(value));
} else if ((m = route.match(/^repos\/[^/]+\/[^/]+\/git\/ref\/(builder-claims\/issue-\d+)$/)) && method === 'GET') {
  if (failing.includes('ref-get')) die('HTTP 403');
  const refs = exists('refs-state.json') ? JSON.parse(read('refs-state.json')) : {};
  const sha = refs['refs/' + m[1]];
  if (!sha) die('HTTP 404');
  // Read snapshot BEFORE barrier so retry racers necessarily propose sibling commits.
  if (process.env.CAS_BARRIER_N) {
    const marker = `${dir}/cas-${process.env.FLOW_ID}`; fs.writeFileSync(marker, '');
    const started = Date.now();
    while (fs.readdirSync(dir).filter(f => f.startsWith('cas-')).length < Number(process.env.CAS_BARRIER_N)) {
      if (Date.now() - started > 10000) die('CAS barrier timeout'); sleep(3);
    }
  }
  emit(JSON.stringify({ ref: 'refs/' + m[1], object: { type: 'commit', sha } }));
} else if ((m = route.match(/^repos\/[^/]+\/[^/]+\/git\/refs\/(builder-claims\/issue-\d+)$/)) && method === 'PATCH') {
  if (failing.includes('claim-update')) die('HTTP 500');
  if (fields.force !== 'false') die('force must be false');
  const accepted = withLock(() => {
    const refs = exists('refs-state.json') ? JSON.parse(read('refs-state.json')) : {};
    const commits = exists('commits-state.json') ? JSON.parse(read('commits-state.json')) : {};
    const ref = 'refs/' + m[1], old = refs[ref];
    let cursor = fields.sha, found = false;
    for (let i = 0; cursor && i < 5; i++) {
      if (cursor === old) { found = true; break; }
      cursor = commits[cursor]?.parents[0]?.sha;
    }
    if (!old || !found) return false;
    refs[ref] = fields.sha; fs.writeFileSync(`${dir}/refs-state.json`, JSON.stringify(refs)); return true;
  });
  if (!accepted) die('gh: Update is not a fast forward (HTTP 422)');
  emit('{}');
} else if ((m = route.match(/^repos\/([^/]+\/[^/]+)\/pulls$/)) && method === 'POST') {
  const repo = m[1];
  const created = withLock(() => {
    const state = JSON.parse(read('pulls-state.json'));
    const pr = {
      number: state.next++, state: 'open', merged_at: null, draft: true,
      html_url: `https://github.com/${repo}/pull/${state.next - 1}`,
      head: { ref: fields.head, repo: { full_name: repo } }, base: { ref: fields.base },
    };
    state.prs.push(pr);
    fs.writeFileSync(`${dir}/pulls-state.json`, JSON.stringify(state));
    return pr;
  });
  emit(JSON.stringify(created));
} else if ((m = route.match(/^repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/)) && method === 'PATCH') {
  withLock(() => {
    const state = JSON.parse(read('pulls-state.json'));
    const pr = state.prs.find((p) => p.number === Number(m[1]));
    if (!pr) die('HTTP 404');
    pr.state = fields.state;
    fs.writeFileSync(`${dir}/pulls-state.json`, JSON.stringify(state));
  });
  process.stdout.write('{}\n');
} else if (/^repos\/[^/]+\/[^/]+\/git\/refs$/.test(route) && method === 'POST') {
  // Atomic exclusive ref creation, like GitHub: 422 "Reference already exists" when the name is taken.
  if (failing.includes('claim')) die('gh: Internal Server Error (HTTP 500)');
  if (!/^refs\/[^/]+\/.+/.test(fields.ref || '') || !/^[0-9a-f]{40}$/.test(fields.sha || '')) die('gh: Validation Failed (HTTP 422)');
  const taken = withLock(() => {
    const file = `${dir}/refs-state.json`;
    const refs = exists('refs-state.json') ? JSON.parse(read('refs-state.json')) : {};
    if (Object.hasOwn(refs, fields.ref)) return true;
    refs[fields.ref] = fields.sha;
    fs.writeFileSync(file, JSON.stringify(refs));
    return false;
  });
  if (taken) die('gh: Reference already exists (HTTP 422)');
  process.stdout.write(JSON.stringify({ ref: fields.ref, object: { sha: fields.sha } }) + '\n');
} else if ((m = route.match(/^repos\/[^/]+\/[^/]+\/git\/refs\/(builder-claims\/.+)$/)) && method === 'DELETE') {
  // Owner release of a stranded claim.
  const removed = withLock(() => {
    const refs = exists('refs-state.json') ? JSON.parse(read('refs-state.json')) : {};
    if (!Object.hasOwn(refs, `refs/${m[1]}`)) return false;
    delete refs[`refs/${m[1]}`];
    fs.writeFileSync(`${dir}/refs-state.json`, JSON.stringify(refs));
    return true;
  });
  if (!removed) die('gh: Reference does not exist (HTTP 422)');
  process.stdout.write('\n');
} else if (/^repos\/[^/]+\/[^/]+\/git\/refs\/heads\//.test(route) && method === 'DELETE') {
  fs.appendFileSync(`${dir}/deleted-refs.log`, route + '\n');
  process.stdout.write('\n');
} else {
  die('unknown route: ' + args.join(' '), 2);
}
