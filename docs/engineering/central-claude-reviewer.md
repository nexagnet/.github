# Central Independent Claude Reviewer — integration and security (R3)

Canonical: https://github.com/nexagnet/.github/issues/4
Dependency: https://github.com/nexagnet/.github/issues/1 (Builder)

## Trust boundaries

- Consumer caller runs from default branch on workflow_run: ci / completed.
- The reusable reviewer *does not* receive any Publisher App credential, App ID/private key, or write token in the Claude job.
- Preflight re-fetches live PR/Issue/CI run/jobs and checks exact 40-byte HEAD, same-repository PR, default target branch, exactly one linked Task Contract and exactly one risk label (R0/R1/R2). R3 rejected.
- CI run must be completed/success, from the trusted ci.yml workflow, with expected PR relationship and all declared job names SUCCESS on current HEAD. Missing evidence fails closed. The currently configured consumer CI contracts are different and must declare appropriate job names.
- Before checkout of PR code with Claude secrets, preflight rejects protected control-plane paths. PR file list of 100 or more is rejected (no false claims when pagination is incomplete).
- Claude has read-only GITHUB_TOKEN; no OIDC/write privileges. Only Read, Glob and Grep are allowed; Bash and editing tools are denied. A trusted step prepares the bounded diff before Claude runs. Its structured model output is untrusted.
- Reporter has pull-requests:write to publish the PR comment, issues:read, NO contents:write and NO Publisher App key. It independently rechecks current PR HEAD, open linked Issue/risk and CI run. The comment is an observation, not merge authorization.
- **Known gap:** Current reporter only posts PASS or REQUEST_CHANGES; it does NOT dispatch Repair, or trigger automatic merge. Those are separate R3 workflow contracts. V4 remains active.
- Contract source scans and local fixtures do not prove runtime. A prior synthetic consumer success does not prove later central changes have been deployed; each rollout needs a real workflow_call, current-SHA verdict, stale-head negative proof and trusted artifact.
- GitHub GITHUB_TOKEN-generated comments generally do not trigger downstream Actions. Repair must use a controlled dispatch or other approved mechanism; do not rely on this comment as a trigger.

## Consumer caller template

After central R3 PR merges and owner reviews exact main SHA, replace CENTRAL_REVIEWED_FULL_SHA. Create a consumer R3 Task Contract and a Draft PR on each repository. Existing consumers also need a separate reviewed pin update; central changes are not inherited automatically. A consumer must not keep simultaneous V4 and new Reviewer active for the same PR.

    name: Nexagnet Reviewer caller
    on:
      workflow_run:
        workflows: [ci]
        types: [completed]
    permissions:
      contents: read
      actions: read
      checks: read
      issues: read
      pull-requests: write
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

Replace required_jobs_csv with the complete exact set from the consumer's current default-branch CI. The tool must never infer successful jobs based solely on one CI workflow conclusion. Event association may be empty for some bot-generated PRs; fail closed and design a separate trusted fallback as its own tested R3 scope.

## Gate diagnostics and recovery

A blocked gate is not a model review and does not mean REQUEST_CHANGES. Claude and
the Reporter do not run after a gate failure. The gate emits a fixed
`REVIEWER_GATE_BLOCKED` reason in the Actions log and step summary, with recovery
guidance. It does not publish a review verdict or an evidence artifact. Diagnostic
messages contain no PR body, Task Contract, comment, changed path or API response.

| Reason | Recovery |
|---|---|
| `INPUTS`, `SOURCE_EVENT` | Check the SHA-pinned default-branch caller and its CI completion inputs. |
| `API_*` | Check the read permissions, GitHub availability and run context; retry only after the cause is resolved. |
| `PR_HEAD_OR_STATE` | Use an open same-repository PR targeting the default branch; run CI for the current HEAD. |
| `ISSUE_REFERENCE_MISSING`, `ISSUE_REFERENCE_AMBIGUOUS`, `ISSUE_REFERENCE_INVALID` | Put exactly one supported reference with a positive Issue number in the PR description: `Refs #123`, `Closes #123` or `Relates to #123`. |
| `PR_PROVENANCE` | Use the documented Publisher or owner-authored Claude branch lane. PR text cannot grant authorization. |
| `OWNER_ATTESTATION` | The owner must post the exact SHA-bound request below; ensure the comments can be fully enumerated. |
| `ISSUE_STATE`, `ISSUE_RISK`, `TASK_CONTRACT` | Use an open canonical Issue with exactly one R0/R1/R2 risk label and all required Task Contract headings. R3 remains owner-controlled. |
| `CI_RUN`, `CI_JOBS` | Require successful CI associated with this PR and current SHA, including every caller-declared required job. |
| `PROTECTED_PATHS` | Review protected control-plane changes through the R3 process; an incomplete file list cannot pass. |
| `BASE_SHA`, `OUTPUTS` | Investigate the trusted workflow/runtime failure before retrying. |

For an owner-authored `claude/*` PR, the GitHub owner must post exactly:

```text
NEXAGNET_REVIEW_REQUEST HEAD_SHA=<current 40-character PR HEAD SHA>
```

An agent must not manufacture this owner attestation. After the Task Contract and
attestation are in place, re-run the CI workflow for the current PR HEAD. A new
commit needs a new SHA-bound owner request. Do not re-run historical CI on merged
PRs as a substitute for proof on an open PR.

Executable local fixtures exercise the actual gate shell with mocked read-only
GitHub responses. They prove diagnostic behavior, not Claude review quality or a
deployed consumer. This change needs exact-head central CI and independent review,
owner-controlled central merge, exact-main CI, a separate consumer SHA-pin PR and
an approved live synthetic PR before claiming rollout/runtime completion.

## R3 merge, rollout and rollback

1. Independent review and required CI on the exact central PR HEAD.
2. Owner-controlled merge of central R3, verify exact-main CI and immutable central SHA.
3. Consumer caller PR under separate R3 Task Contract. Keep V4 intact until new Reviewer proof is obtained; prevent double review/repair.
4. Runtime proof: real Issue -> Builder -> Draft PR -> exact-head CI -> Reviewer PASS/REQUEST_CHANGES comments on exact SHA. Push another commit, ensure old result cannot authorize anything.
5. If errors, disable only the new consumer caller via R3 owner-approved PR. V4 is fallback. Do not auto-merge R2/R3 or deploy production.

No App installation, secret provisioning, repo ruleset or production changes are authorized by this file.
