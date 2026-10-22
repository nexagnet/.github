'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {execFileSync, spawnSync} = require('node:child_process');
const path = require('node:path');
const repo = path.resolve(__dirname, '..');
const file = path.join(repo, '.github/workflows/claude-reviewer.yml');
const source = readFileSync(file, 'utf8');
const workflow = JSON.parse(execFileSync('ruby', [
  '-ryaml', '-rjson', '-e',
  'puts JSON.generate(YAML.load_file(ARGV[0]))', file
], {encoding: 'utf8'}));
const jobs = workflow.jobs;
const preflight = jobs.gate.steps.find(s => s.id === 'verify').run;
const reviewer = jobs.review.steps.find(s => s.id === 'claude');
const reporter = jobs.report.steps[0].run;

test('workflow_call interface and no implicit permissions', () => {
  const caller = (workflow.on || workflow.true).workflow_call;
  assert.equal(caller.inputs.pr_number.type, 'number');
  assert.equal(caller.inputs.expected_head_sha.required, true);
  assert.equal(caller.inputs.ci_run_id.required, true);
  assert.equal(caller.inputs.required_jobs_csv.required, true);
  assert.equal(caller.secrets.CLAUDE_CODE_OAUTH_TOKEN.required, true);
  assert.deepEqual(workflow.permissions, {});
  assert.ok(!source.includes('secrets: inherit'));
});

test('reviewer is an independent non-writing agent with exact SHA', () => {
  assert.equal(jobs.review.permissions.contents, 'read');
  assert.equal(jobs.review.permissions.issues, 'read');
  assert.equal(jobs.review.permissions['pull-requests'], 'read');
  assert.equal(jobs.review.permissions['id-token'], undefined);
  const checkout = jobs.review.steps[0];
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(checkout.with.ref, '\${{ needs.gate.outputs.head }}');
  assert.equal(reviewer.with.github_token, '\${{ github.token }}');
  assert.match(reviewer.with.claude_args, /--json-schema/);
  assert.match(reviewer.with.claude_args, /--allowedTools "Read,Glob,Grep"/);
  assert.match(reviewer.with.claude_args, /--disallowedTools "Bash,Edit,Write,/);
  assert.equal(reviewer.with.show_full_output, 'false');
  assert.ok(!JSON.stringify(jobs.review).includes('BUILDER_PUBLISHER_APP_PRIVATE_KEY'));
});

test('deterministic preflight verifies exact-head CI, complete job set, issuer and risk', () => {
  for(const token of [
    'workflow_run','workflow_run.id', 'workflow_run.conclusion',
    'pulls/$PR', '.head.sha == $sha', '.head.repo.full_name == $repo',
    '.base.ref == $base', 'risk:R0|risk:R1|risk:R2',
    '.head_sha == $sha', '.conclusion == "success"',
    'actions/runs/$RUN/jobs?per_page=100',
    '.status == "completed"', '.name == $n',
    'length == 1', 'test "$(jq length <<< "$files")" -lt 100',
    'contract=$(printf'
  ]) assert.ok(preflight.includes(token), 'missing: ' + token);
  assert.ok(!preflight.includes('risk:R3) ;;'));
  assert.equal(jobs.gate.permissions['issues'], 'read');
  assert.equal(jobs.gate.permissions['actions'], 'read');
});

test('only publisher bot PRs on issue-specific branch reach Reviewer', () => {
  assert.match(preflight, /claude\/issue-/);
  assert.match(preflight, /nexagnet-builder-publisher\[bot\]/);
  assert.match(preflight, /head\.repo\.full_name == \$repo/);
  assert.match(preflight, /issue_id/);
});

test('protected path gate includes workflow, automation and instruction file attacks', () => {
  const check = preflight.match(/jq -e 'all\(\.\[\];[\s\S]*?' <<< "\$files" >\/dev\/null/);
  assert.ok(check, 'Expected fail-closed protection applied to GitHub PR file listing');
  // Also assert directly on the jq expression; integration proof remains required.
  for(const name of ['.github', '.claude', 'infra/', 'deploy/', 'tools/autopilot/', 'agents', 'claude', 'mcp']) {
    assert.ok(check[0].toLowerCase().includes(name), 'missing guard for: ' + name);
  }
});

test('trusted reporter rechecks PR HEAD, Issue risk and CI run after Claude', () => {
  assert.deepEqual(jobs.report.needs, ['gate','review']);
  assert.equal(jobs.report.permissions.contents, 'read');
  assert.equal(jobs.report.permissions.issues, 'read');
  assert.equal(jobs.report.permissions['pull-requests'], 'write');
  assert.equal(jobs.report.permissions['id-token'], undefined);
  assert.equal(jobs.report.permissions.contents, 'read');
  assert.match(reporter, /\.head\.sha == \$sha/);
  assert.match(reporter, /\.head_sha == \$sha/);
  assert.match(reporter, /risk:\$RISK/);
  assert.match(reporter, /REQUEST_CHANGES/);
  assert.match(reporter, /Not merge authorization/);
  assert.doesNotMatch(reporter, /gh pr merge|git push|repository_dispatch/);
});

test('Reviewer creates trusted run-scoped structured evidence only after revalidation', () => {
  const reporter = jobs.report;
  assert.ok(reporter.steps[0].run.includes('review-evidence.json'));
  assert.match(reporter.steps[0].run, /nexagnet-review-v1/);
  assert.match(reporter.steps[0].run, /ci_run_id/);
  const artifact = reporter.steps.find(s => s.name?.startsWith('Upload exact-head reviewer evidence'));
  assert.ok(artifact);
  assert.equal(artifact.with.name,'nexagnet-review-evidence');
  assert.equal(artifact.with['if-no-files-found'],'error');
  assert.equal(artifact.with['retention-days'],14);
});

test('every external action is pinned to 40-character immutable SHA', () => {
  const actions = [...source.matchAll(/uses: ([^\s]+)@([^\s]+)/g)];
  assert.ok(actions.length >= 2);
  for(const [, name, sha] of actions) {
    assert.match(sha, /^[0-9a-f]{40}$/, name);
  }
});

test('Independent Reviewer bootstraps bubblewrap before the scrubbed Claude action', () => {
  const review = jobs.review;
  const install = review.steps.find(s => s.name === 'Install bubblewrap for isolated Claude subprocesses');
  assert.ok(install, 'bubblewrap prerequisite is required');
  assert.ok(review.steps.indexOf(install) < review.steps.indexOf(reviewer));
  assert.match(install.run, /set -euo pipefail/);
  assert.match(install.run, /sudo apt-get install -y --no-install-recommends bubblewrap/);
  assert.match(install.run, /command -v bwrap/);
  assert.match(install.run, /bwrap --version/);
  assert.equal(reviewer.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1');
  assert.ok(!/CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0/.test(source));
  assert.equal(install.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test('official Claude Reviewer action allowlists only the trusted Publisher bot actor', () => {
  assert.equal(reviewer.with.allowed_bots, 'nexagnet-builder-publisher[bot]');
  assert.notEqual(reviewer.with.allowed_bots, '*');
  assert.equal(reviewer.with.allowed_non_write_users, undefined);
  assert.ok(preflight.includes('nexagnet-builder-publisher[bot]'));
  assert.ok(preflight.includes('.user.type == "Bot"'));
  assert.ok(preflight.includes('.head.sha == $sha'));
  assert.equal(jobs.review.permissions.contents, 'read');
  assert.equal(jobs.review.permissions['pull-requests'], 'read');
  assert.equal(jobs.review.permissions['id-token'], undefined);
  assert.ok(!JSON.stringify(jobs.review).includes('BUILDER_PUBLISHER_APP_PRIVATE_KEY'));
});

test('trusted Reviewer prepares bounded exact-base-to-head diff before Claude without sandbox Bash', () => {
  assert.equal(jobs.gate.outputs.base_sha, '${{ steps.verify.outputs.base_sha }}');
  assert.ok(preflight.includes('base_sha="$(jq -r .base.sha <<< "$pr")"'));
  assert.ok(preflight.includes('echo "base_sha=$base_sha"'));
  const steps = jobs.review.steps;
  const diff = steps.find(x => x.name === 'Prepare bounded trusted PR diff for read-only Claude');
  assert.ok(diff, 'trusted diff generator step must exist');
  assert.ok(steps.indexOf(diff) < steps.indexOf(steps.find(x => x.id === 'claude')));
  assert.equal(diff.env.BASE, '${{ needs.gate.outputs.base_sha }}');
  assert.equal(diff.env.HEAD_SHA, '${{ needs.gate.outputs.head }}');
  assert.match(diff.run, /test "\$\(git rev-parse HEAD\)" = "\$HEAD_SHA"/);
  assert.ok(diff.run.includes('git cat-file -e "${BASE}^{commit}"'));
  assert.ok(diff.run.includes('git diff --no-ext-diff --no-textconv "$BASE...$HEAD_SHA" --'));
  assert.ok(diff.run.includes('> "$RUNNER_TEMP/reviewer-pr-diff.patch"'));
  assert.ok(diff.run.includes('test -s "$RUNNER_TEMP/reviewer-pr-diff.patch"'));
  assert.ok(diff.run.includes('-le 500000'));
  assert.ok(reviewer.with.prompt.includes('reviewer-pr-diff.patch'));
  assert.ok(reviewer.with.prompt.includes('UNTRUSTED data'));
  assert.ok(reviewer.with.prompt.includes('diff_inspected=false'));
  assert.doesNotMatch(reviewer.with.claude_args, /Bash\(git /);
  assert.match(reviewer.with.claude_args, /--disallowedTools "Bash,/);
  assert.match(reviewer.with.claude_args, /"diff_inspected":\{"type":"boolean"\}/);
});

test('trusted Reporter is the only PR-comment writer and enforces diff inspection', () => {
  const run = jobs.report.steps[0].run;
  assert.equal(jobs.gate.permissions['pull-requests'], 'read');
  assert.equal(jobs.review.permissions['pull-requests'], 'read');
  assert.equal(jobs.report.permissions['pull-requests'], 'write');
  assert.equal(jobs.report.permissions.issues, 'read');
  assert.equal(jobs.report.permissions.contents, 'read');
  assert.equal(jobs.report.permissions['id-token'], undefined);
  assert.match(run, /\.diff_inspected \| type == "boolean"/);
  assert.match(run, /\.verdict == "PASS" then \.diff_inspected == true/);
  const artifactIndex = run.indexOf('> "$RUNNER_TEMP/review-evidence.json"');
  const commentIndex = run.indexOf('gh api -X POST "repos/$GITHUB_REPOSITORY/issues/$PR/comments"');
  assert.ok(artifactIndex >= 0 && commentIndex > artifactIndex, 'evidence assembled before publishing');
  assert.match(run, /jq -e --arg sha "\$SHA"/);
  assert.doesNotMatch(run, /gh pr merge|git push|repository_dispatch/);
  assert.ok(!JSON.stringify(jobs.review).includes('BUILDER_PUBLISHER_APP_PRIVATE_KEY'));
});


test('manual Claude Project lane needs owner-authored PR and SHA-bound comment; Publisher lane stays strict', () => {
  assert.match(preflight, /provenance=publisher/);
  assert.match(preflight, /provenance=owner/);
  assert.match(preflight, /\.user\.login == "nexagnet-builder-publisher\[bot\]"/);
  assert.match(preflight, /\.user\.login == "phungtienviet14-sketch" and \.user\.type == "User"/);
  assert.match(preflight, /NEXAGNET_REVIEW_REQUEST HEAD_SHA=/);
  assert.match(preflight, /No current-SHA owner review attestation/);
  assert.match(preflight, /Untrusted PR provenance/);
  assert.match(preflight, /\[\[ "\$branch" =~ \^claude\//);
  assert.ok(jobs.gate.outputs.provenance.includes('steps.verify.outputs.provenance'));
  assert.ok(jobs.gate.outputs.contract_hash.includes('steps.verify.outputs.contract_hash'));
  assert.ok(!preflight.includes("allowed_bots: '*'"));
});

test('actual GitHub jq attestation predicate rejects spoof, stale SHA and bot impersonation', () => {
  const q = preflight.match(/jq -e --arg sha "\$SHA" '([\s\S]*?)' <<< "\$comments"/);
  assert.ok(q, 'owner comment predicate must be executable');
  const sha = 'a'.repeat(40);
  const owner = (body, login = 'phungtienviet14-sketch', type = 'User') =>
    ({user:{login,type},body});
  const exact = 'NEXAGNET_REVIEW_REQUEST HEAD_SHA=' + sha;
  const cases = [
    [[owner(exact)], true],
    [[owner(exact, 'attacker')], false],
    [[owner(exact, 'phungtienviet14-sketch', 'Bot')], false],
    [[owner(exact.slice(0, -1) + 'b')], false],
    [[owner(exact + ' --skip-checks')], false],
    [[owner('readme'), owner(exact)], true],
  ];
  for (const [comments, expected] of cases) {
    const result = spawnSync('jq', ['-e', '--arg', 'sha', sha, q[1]], {
      input: JSON.stringify(comments), encoding: 'utf8'
    });
    assert.equal(result.status === 0, expected, JSON.stringify(comments));
  }
});

test('trusted Reporter revalidates manual consent and contract after AI review', () => {
  assert.match(reporter, /PROVENANCE/);
  assert.match(reporter, /Unknown reviewer provenance/);
  assert.match(reporter, /NEXAGNET_REVIEW_REQUEST HEAD_SHA=/);
  assert.match(reporter, /Task Contract drift after review/);
  assert.match(reporter, /CONTRACT_HASH/);
  assert.match(reporter, /pull_requests\[\]\?\.number/);
  assert.equal(jobs.report.steps[0].env.PROVENANCE.includes('needs.gate.outputs.provenance'), true);
  assert.equal(jobs.report.steps[0].env.CONTRACT_HASH.includes('needs.gate.outputs.contract_hash'), true);
  assert.equal(jobs.gate.permissions['pull-requests'], 'read');
  assert.equal(jobs.review.permissions['pull-requests'], 'read');
  assert.equal(jobs.report.permissions['pull-requests'], 'write');
});

test('UI parity is configured only by trusted caller and detects renamed UI paths', () => {
  const caller = (workflow.on || workflow.true).workflow_call;
  assert.equal(caller.inputs.ui_paths_csv.default, 'apps/web');
  assert.equal(caller.inputs.figma_parity_spec_path.default, 'docs/design/figma-parity.md');
  assert.equal(jobs.gate.outputs.ui_required, '${{ steps.verify.outputs.ui_required }}');
  assert.match(preflight, /previous_filename/);
  assert.match(preflight, /UI_PATHS/);
  assert.match(preflight, /pr_body_b64/);
});

test('actual UI path classifier catches additions, deletions and moves without prefix collisions', () => {
  const predicate = preflight.match(/# BEGIN UI CLASSIFIER\n[\s\S]*?jq -c --arg roots "\$UI_PATHS" '([\s\S]*?)' <<< "\$files"/);
  assert.ok(predicate, 'classifier must be executable independently');
  const cases = [
    [[{filename:'apps/web/page.tsx'}], true],
    [[{filename:'apps/web/page.tsx',status:'removed'}], true],
    [[{filename:'docs/moved.tsx',previous_filename:'apps/web/page.tsx'}], true],
    [[{filename:'apps/portal/page.tsx'}], true],
    [[{filename:'apps/website/page.tsx'}], false],
    [[{filename:'docs/readme.md'}], false],
    [[], false],
  ];
  for (const [files, expected] of cases) {
    const result = spawnSync('jq', ['-c','--arg','roots','apps/web,apps/portal',predicate[1]], {
      input: JSON.stringify(files), encoding:'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).length > 0, expected, JSON.stringify(files));
  }
});

test('trusted UI policy rejects traversal, globs, empty roots and multiline output injection', () => {
  const predicate = preflight.match(/jq -en --arg roots "\$UI_PATHS" --arg spec "\$SPEC_PATH" '([\s\S]*?)' >\/dev\/null/);
  assert.ok(predicate);
  const cases = [
    ['apps/web', 'docs/design/figma-parity.md', true],
    ['apps/web,src/ui', 'docs/parity.md', true],
    ['', 'docs/parity.md', false],
    ['apps/../web', 'docs/parity.md', false],
    ['apps/web/**', 'docs/parity.md', false],
    ['apps/web\nui_required=false', 'docs/parity.md', false],
    ['apps/web', '../parity.md', false],
    ['apps/web', '/tmp/parity.md', false],
    ['apps/web', 'docs/parity.txt', false],
  ];
  for (const [roots, spec, expected] of cases) {
    const result = spawnSync('jq', ['-en','--arg','roots',roots,'--arg','spec',spec,predicate[1]], {encoding:'utf8'});
    assert.equal(result.status === 0, expected, JSON.stringify({roots,spec}));
  }
});

test('parity material is frozen and baseline spec is read without external URLs or execution', () => {
  const step = jobs.review.steps.find(s => s.name === 'Prepare bounded Figma parity context');
  assert.ok(step);
  assert.equal(step.env.BASE, '${{ needs.gate.outputs.base_sha }}');
  assert.equal(step.env.PR_BODY_B64, '${{ needs.gate.outputs.pr_body_b64 }}');
  assert.match(step.run, /git show "\$BASE:\$SPEC_PATH"/);
  assert.doesNotMatch(step.run, /curl|wget|gh api|eval/);
  assert.match(reviewer.with.prompt, /Đối chiếu Figma/);
  assert.match(reviewer.with.prompt, /NOT_VERIFIED/);
});

test('UI visual proof remains deterministically unverified even when model claims PASS', () => {
  const guard = reporter.match(/# BEGIN UI PARITY GUARD\n[\s\S]*?RESULT="\$\(jq --arg path "\$UI_PATH" '([\s\S]*?)' <<< "\$RESULT"\)"/);
  assert.ok(guard);
  for (const verdict of ['PASS','REQUEST_CHANGES']) {
    const result = spawnSync('jq', ['--arg','path','apps/web/page.tsx',guard[1]], {
      input: JSON.stringify({head_sha:'a'.repeat(40),diff_inspected:true,verdict,summary:'review',findings:[]}),encoding:'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const review = JSON.parse(result.stdout);
    assert.equal(review.verdict, 'REQUEST_CHANGES');
    assert.equal(review.head_sha, 'a'.repeat(40));
    assert.equal(review.diff_inspected, true);
    assert.equal(review.findings[0].severity, 'blocker');
    assert.match(review.findings[0].message, /VISUAL_EVIDENCE_NOT_VERIFIED/);
  }
  assert.match(reporter, /figma_parity_status/);
  assert.match(reporter, /NOT_REQUIRED/);
  assert.match(reporter, /NOT_VERIFIED/);
});
