'use strict';
// Runs the REAL inline shell of claude-builder.yml against a fake GitHub.
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const OWNER = 'phungtienviet14-sketch';
const REPO = 'nexagnet/example';
const workflowPath = resolve(__dirname, '../../.github/workflows/claude-builder.yml');
const fakeGh = resolve(__dirname, 'fake-gh.cjs');

// Ruby Psych ships on the CI runner; parsing first also proves valid YAML.
const workflow = JSON.parse(execFileSync(
  'ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.load_file(ARGV[0]))', workflowPath],
  { encoding: 'utf8' }
));
const source = readFileSync(workflowPath, 'utf8');
const jobs = workflow.jobs;

const HEADINGS = ['OBJECTIVE', 'SCOPE', 'OUT OF SCOPE', 'ACCEPTANCE', 'RISK', 'RUNTIME PROOF', 'STOP CONDITIONS']
  .map((h) => '## ' + h).join('\n');

const issue = (over = {}) => ({
  state: 'open', labels: [{ name: 'risk:R1' }, { name: 'autopilot:ready' }], body: HEADINGS, ...over,
});
const event = ({ body = '@claude', id = 5000, login = OWNER, type = 'User', sender = login, number = 12, action = 'created', pr = false } = {}) => ({
  action,
  issue: pr ? { number, pull_request: { url: 'x' } } : { number },
  comment: { id, body, user: { login, type } },
  sender: { login: sender },
});
const comment = (id, body, login = OWNER, type = 'User') => ({ id, body, user: { login, type } });
const pull = (number, ref, state = 'open', { merged = false, repo = REPO } = {}) => ({
  number, state, merged_at: merged ? '2026-10-19T00:00:00Z' : null,
  head: { ref, repo: repo === null ? null : { full_name: repo } },
});
const live = (ev, over = {}) => ({
  id: ev.comment.id, body: ev.comment.body, user: ev.comment.user,
  issue_url: `https://api.github.com/repos/${REPO}/issues/12`, ...over,
});

const stepByName = (job, prefix) => jobs[job].steps.find((s) => s.name?.startsWith(prefix));

function makeWorld({ ev = event(), iss = issue(), comments = [[]], pulls = [[]], liveComment, dynamicPulls, actor = OWNER, repo = REPO } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nexagnet-builder-world-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/bin/bash\nexec node "${fakeGh}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'calls.log'), '');
  writeFileSync(join(dir, 'event.json'), JSON.stringify(ev));
  writeFileSync(join(dir, 'issue.json'), JSON.stringify(iss));
  writeFileSync(join(dir, 'live-comment.json'), JSON.stringify(liveComment ?? live(ev)));
  comments.forEach((page, i) => writeFileSync(join(dir, `comments-${i + 1}.json`), JSON.stringify(page)));
  pulls.forEach((page, i) => writeFileSync(join(dir, `pulls-${i + 1}.json`), JSON.stringify(page)));
  if (dynamicPulls) writeFileSync(join(dir, 'pulls-state.json'), JSON.stringify({ next: 100, prs: dynamicPulls }));
  return { dir, bin, actor, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const baseEnv = (world, extra) => ({
  ...process.env,
  PATH: world.bin + ':' + process.env.PATH,
  FAKE_GH_DIR: world.dir,
  GITHUB_REPOSITORY_OWNER: 'nexagnet', GITHUB_REPOSITORY: world.repo,
  GITHUB_EVENT_NAME: 'issue_comment', GITHUB_ACTOR: world.actor,
  GITHUB_EVENT_PATH: join(world.dir, 'event.json'),
  GITHUB_OUTPUT: join(world.dir, 'gh-output'), GITHUB_RUN_ATTEMPT: '1',
  GH_TOKEN: 'test-read-only-token', ISSUE_NUMBER: '12',
  ...extra,
});

function parseOutputs(world) {
  const out = {};
  for (const line of readFileSync(join(world.dir, 'gh-output'), 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

function runScript(world, script, extra = {}) {
  writeFileSync(join(world.dir, 'gh-output'), '');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: baseEnv(world, extra) });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout, stderr: r.stdout + r.stderr, outputs: parseOutputs(world) };
}

function spawnScript(world, scriptFile, extra = {}) {
  return new Promise((done) => {
    const child = spawn('bash', [scriptFile], { env: baseEnv(world, extra) });
    let stderr = '';
    child.stdout.on('data', (d) => { stderr += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => done({ ok: status === 0, status, stderr }));
  });
}

// Extract the shell function `name() { ... }` (closing brace at column 0 after dedent).
function extractFunction(script, name) {
  const start = script.indexOf(`${name}() {`);
  if (start < 0) return null;
  const end = script.indexOf('\n}\n', start);
  return script.slice(start, end + 3);
}

module.exports = {
  OWNER, REPO, workflow, source, jobs, issue, event, comment, pull, live,
  stepByName, makeWorld, runScript, spawnScript, extractFunction, writeFileSync, join,
};
