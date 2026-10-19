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

if (args[0] !== 'api') die('unknown gh invocation: ' + args.join(' '), 2);
const paginate = args.includes('--paginate');
const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET';
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
} else if (/^repos\/[^/]+\/[^/]+\/git\/refs\/heads\//.test(route) && method === 'DELETE') {
  fs.appendFileSync(`${dir}/deleted-refs.log`, route + '\n');
  process.stdout.write('\n');
} else {
  die('unknown route: ' + args.join(' '), 2);
}
