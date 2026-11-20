'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { tmpdir } = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const script = path.join(repoRoot, 'scripts/bootstrap-repo.sh');
const fake = path.join(__dirname, 'support/fake-gh-bootstrap.cjs');
const R = 'nexagnet/sample';
const SHA = 'a'.repeat(40);

function freshState(extra = {}) {
  return { repo: R, user: 'owner-login', labels: {}, files: {}, refs: { main: 'b'.repeat(40) },
    pulls: [], rulesets: [], settings: null, ...extra };
}
function run(args, state = freshState()) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bootstrap-'));
  try {
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
    writeFileSync(path.join(dir, 'calls.log'), '');
    writeFileSync(path.join(dir, 'gh'), `#!/bin/sh\nexec node "${fake}" "$@"\n`);
    chmodSync(path.join(dir, 'gh'), 0o755);
    const result = spawnSync('bash', [script, ...args], { encoding: 'utf8', timeout: 60000,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_GH_DIR: dir } });
    return { ...result, state: JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')),
      calls: readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const writes = (calls) => calls.filter((c) => !c.startsWith('GET '));

test('dry-run không ghi gì và in kế hoạch', () => {
  const r = run([R, '--pin-sha', SHA]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(writes(r.calls), []);
  assert.match(r.stdout, /DRY-RUN/);
  assert.match(r.stdout, /SẼ LÀM: tạo nhãn needs-human/);
  assert.match(r.stdout, /HOÃN: nhánh main chưa có/);
});

test('apply lần đầu: nhãn, squash-only, PR file mẫu; ruleset hoãn vì chưa có ci.yml', () => {
  const r = run([R, '--apply', '--pin-sha', SHA, '--ignore-regex', '\\.meta$']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.state.labels['needs-human']);
  assert.equal(r.state.settings.allow_squash_merge, true);
  assert.equal(r.state.settings.allow_merge_commit, false);
  assert.equal(r.state.settings.allow_rebase_merge, false);
  assert.equal(r.state.settings.delete_branch_on_merge, true);
  const caller = r.state.files['claude/bootstrap-repo-ci:.github/workflows/nexagnet-claude-reviewer.yml'];
  assert.match(caller, new RegExp(`claude-reviewer.yml@${SHA}`));
  assert.match(caller, /required_jobs_csv: test,lint/);
  assert.match(caller, /trusted_authors_csv: owner-login/);
  assert.match(caller, /ignore_count_regex: '\\\.meta\$'/);
  assert.doesNotMatch(caller, /__[A-Z_]+__/);
  const ci = r.state.files['claude/bootstrap-repo-ci:.github/workflows/ci.yml'];
  assert.match(ci, /^name: ci$/m);
  assert.match(ci, /exit 1/, 'CI mẫu phải đỏ cho tới khi được cấu hình');
  assert.equal(r.state.pulls.length, 1);
  assert.deepEqual(r.state.rulesets, []);
  assert.match(r.stdout, /HOÃN/);
});

test('idempotent: chạy lại không tạo thêm PR/nhánh/file', () => {
  const first = run([R, '--apply', '--pin-sha', SHA]);
  const second = run([R, '--apply', '--pin-sha', SHA], first.state);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.state.pulls.length, 1);
  assert.match(second.stdout, /Đã có PR bootstrap đang mở/);
  assert.ok(!second.calls.includes(`POST repos/${R}/pulls`));
  assert.ok(!second.calls.includes(`POST repos/${R}/git/refs`));
});

test('ruleset được tạo khi default branch đã có ci.yml, đúng nội dung an toàn', () => {
  const state = freshState({ files: { 'main:.github/workflows/ci.yml': 'x', 'main:.github/workflows/nexagnet-claude-reviewer.yml': 'y' } });
  const r = run([R, '--apply', '--checks', 'domain-tests,meta-check', '--pin-sha', SHA], state);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.state.pulls.length, 0, 'file đã có thì không mở PR');
  const rs = r.state.rulesets[0];
  assert.equal(rs.name, 'main-protection');
  assert.equal(rs.enforcement, 'active');
  assert.deepEqual(rs.bypass_actors, []);
  assert.deepEqual(rs.conditions.ref_name.include, ['~DEFAULT_BRANCH']);
  const types = rs.rules.map((x) => x.type).sort();
  assert.deepEqual(types, ['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks']);
  const pr = rs.rules.find((x) => x.type === 'pull_request').parameters;
  assert.equal(pr.required_approving_review_count, 0);
  assert.deepEqual(pr.allowed_merge_methods, ['squash']);
  const sc = rs.rules.find((x) => x.type === 'required_status_checks').parameters;
  assert.deepEqual(sc.required_status_checks, [{ context: 'domain-tests' }, { context: 'meta-check' }]);
});

test('ruleset đã có thì cập nhật (PUT), không tạo trùng', () => {
  const state = freshState({ files: { 'main:.github/workflows/ci.yml': 'x', 'main:.github/workflows/nexagnet-claude-reviewer.yml': 'y' },
    rulesets: [{ id: 7, name: 'main-protection', rules: [] }] });
  const r = run([R, '--apply', '--pin-sha', SHA], state);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.state.rulesets.length, 1);
  assert.ok(r.calls.includes(`PUT repos/${R}/rulesets/7`));
  assert.ok(!r.calls.includes(`POST repos/${R}/rulesets`));
});

test('đầu vào sai bị từ chối trước khi ghi', () => {
  for (const args of [['not-a-repo'], [R, '--checks', 'solo'], [R, '--pin-sha', 'abc'], [R, '--bogus'],
    [R, '--ignore-regex', "a'b"], [R, '--authors', 'x;y', '--apply']]) {
    const r = run(args);
    assert.notEqual(r.status, 0, JSON.stringify(args));
    assert.deepEqual(writes(r.calls), [], JSON.stringify(args));
  }
});

test('--skip-* bỏ qua đúng phần', () => {
  const r = run([R, '--apply', '--skip-labels', '--skip-settings', '--skip-files', '--skip-ruleset']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(writes(r.calls), []);
});

test('--check-org chỉ đọc và báo rõ khi không đọc được', () => {
  const r = run(['--check-org', 'nexagnet']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(writes(r.calls), []);
  assert.match(r.stdout, /Không đọc được/);
});

test('ci.yml mẫu hợp lệ cho actionlint-style kiểm tra: tên workflow và 2 job', () => {
  const t = readFileSync(path.join(repoRoot, 'templates/repo-bootstrap/ci.yml'), 'utf8');
  assert.match(t, /^name: ci$/m);
  assert.match(t, /^  test:$/m);
  assert.match(t, /^  lint:$/m);
  assert.match(t, /actions\/checkout@[0-9a-f]{40}/);
});

test('--with-merge-bot bị từ chối trước mọi thao tác ghi khi chưa có workflow bot merge', () => {
  const r = run([R, '--apply', '--with-merge-bot']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /claude-autonomy\.yml/);
  assert.deepEqual(writes(r.calls), []);
});
