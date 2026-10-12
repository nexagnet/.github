# Central Independent Claude Reviewer — integration and security (R3)

Canonical: https://github.com/nexagnet/.github/issues/4
Dependency: https://github.com/nexagnet/.github/issues/1 (Builder)
Staging PR: compare r3/central-claude-builder-1...r3/central-claude-reviewer-4

## Trust boundaries

- Consumer caller runs from default branch on workflow_run: ci / completed.
- The reusable reviewer *does not* receive any Publisher App credential, App ID/private key, or write token in the Claude job.
- Preflight re-fetches live PR/Issue/CI run/jobs and checks exact 40-byte HEAD, same-repository PR, default target branch, exactly one linked Task Contract and exactly one risk label (R0/R1/R2). R3 rejected.
- CI run must be completed/success, from the trusted ci.yml workflow, with expected PR relationship and all declared job names SUCCESS on current HEAD. Missing evidence fails closed. The currently configured consumer CI contracts are different and must declare appropriate job names.
- Before checkout of PR code with Claude secrets, preflight rejects protected control-plane paths. PR file list of 100 or more is rejected (no false claims when pagination is incomplete).
- Claude has read-only GITHUB_TOKEN; no OIDC/write privileges. Read allowed, code execution denied except read-only git commands. Its structured model output is untrusted.
- Reporter has issues:write solely to comment on PR, but has NO contents:write and NO Publisher App key. It independently rechecks current PR HEAD, open linked Issue/risk and CI run. The comment is an observation, not merge authorization.
- **Known gap:** Current reporter only posts PASS or REQUEST_CHANGES; it does NOT dispatch Repair, or trigger automatic merge. Those are separate R3 workflow contracts. V4 remains active.
- **Known gap:** Contract source scan and static tests do not prove runtime. Need consumer real workflow_call, stale-head negative test, CI runner, Claude OAuth access, and reporter comment test.
- GitHub GITHUB_TOKEN-generated comments generally do not trigger downstream Actions. Repair must use a controlled dispatch or other approved mechanism; do not rely on this comment as a trigger.

## Consumer caller sketch — NOT YET ACTIVE

After central R3 PR merges and owner reviews exact main SHA, replace CENTRAL_REVIEWED_FULL_SHA. Create a consumer R3 Task Contract and a Draft PR on each repository (BMSL #112; platform #470). A consumer must not keep simultaneous V4 and new Reviewer active for the same PR.

    name: Nexagnet Reviewer caller
    on:
      workflow_run:
        workflows: [ci]
        types: [completed]
    permissions:
      contents: read
      actions: read
      checks: read
      issues: write
      pull-requests: read
    jobs:
      review:
        if: >-
          github.event.workflow_run.event == 'pull_request' &&
          github.event.workflow_run.conclusion == 'success' &&
          github.event.workflow_run.pull_requests[0].number != null
        uses: nexagnet/.github/.github/workflows/claude-reviewer.yml@CENTRAL_REVIEWED_FULL_SHA
        with:
          pr_number: ${{ github.event.workflow_run.pull_requests[0].number }}
          expected_head_sha: ${{ github.event.workflow_run.head_sha }}
          ci_run_id: ${{ github.event.workflow_run.id }}
          required_jobs_csv: verify,integration
        secrets:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}

BMSL currently has verify+integration. Platform has seven required CI jobs, so replace required_jobs_csv with the complete exact set from its main CI. The tool must never infer successful jobs based solely on one CI workflow conclusion. Event association may be empty for some bot-generated PRs; fail closed and design a separate trusted fallback as its own tested R3 scope.

## R3 merge, rollout and rollback

1. Independent review and required CI on the exact central PR HEAD.
2. Owner-controlled merge of central R3, verify exact-main CI and immutable central SHA.
3. Consumer caller PR under separate R3 Task Contract. Keep V4 intact until new Reviewer proof is obtained; prevent double review/repair.
4. Runtime proof: real Issue -> Builder -> Draft PR -> exact-head CI -> Reviewer PASS/REQUEST_CHANGES comments on exact SHA. Push another commit, ensure old result cannot authorize anything.
5. If errors, disable only the new consumer caller via R3 owner-approved PR. V4 is fallback. Do not auto-merge R2/R3 or deploy production.

No App installation, secret provisioning, repo ruleset or production changes are authorized by this file.
