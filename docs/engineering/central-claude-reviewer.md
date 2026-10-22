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

## UI/Figma parity guard — Issue #22 (source implemented, runtime NOT VERIFIED)

The trusted default-branch caller can declare `ui_paths_csv` (comma-separated directory roots, default `apps/web`) and `figma_parity_spec_path` (default `docs/design/figma-parity.md`). `apps/web` is always included. Directory matching covers additions, deletions and both sides of a rename without matching `apps/website`. Caller policy is validated; Issue/PR text cannot disable it.

For UI changes, the reviewer reads a bounded frozen PR body and a parity specification taken from verified PR BASE. The PR should contain a "Đối chiếu Figma" section with Figma file/node, design image, runtime image bound to current HEAD, states/viewports, and approved differences. The specification is data, and a PR cannot replace the baseline specification used for its own review. No external image URL is fetched by this change.

**Current limitation:** the read-only review lane has no independently verified Figma/runtime screenshot transport. Consequently the trusted reporter always records `figma_parity_status: NOT_VERIFIED` and `REQUEST_CHANGES` for UI changes, even if Claude claims PASS. Non-UI reviews retain their behavior and record `NOT_REQUIRED`. This prevents an unsupported visual PASS; it does not implement authenticated Figma parity or satisfy the complete acceptance for #22. A separately reviewed evidence transport and actual visual runtime proof are still required before UI can pass. Missing parity evidence is an external evidence blocker, not a request for Repair to fabricate images or credentials. Existing bounded retry policy must still apply.

The evidence remains `nexagnet-review-v1`, with the existing `review.head_sha`, `review.verdict`, `review.diff_inspected` and findings consumed by Repair. Each result remains tied to the current HEAD and is revalidated before publication. No merge permission is granted.

Rollout requires central R3 owner merge, exact-main CI and a separate consumer R3 immutable-SHA repin; this source PR does not activate the guard in existing pinned callers. Rollback is a consumer repin to its previously reviewed central SHA. Do not roll out to UI consumers expecting automatic visual acceptance until the remaining transport gate is resolved.
