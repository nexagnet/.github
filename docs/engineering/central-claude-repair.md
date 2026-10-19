# Claude Repair V5 — shared workflow, staged R3

Canonical Task Contract: [nexagnet/.github#7](https://github.com/nexagnet/.github/issues/7).

## Scope and verified prerequisites

- Live V5 synthetic smoke in `nexagnet/legal-office`: [Issue #28](https://github.com/nexagnet/legal-office/issues/28), [Draft PR #31](https://github.com/nexagnet/legal-office/pull/31) (subsequently closed, **unmerged**), [Reviewer run 38226777924](https://github.com/nexagnet/legal-office/actions/runs/38226777924) and trusted evidence artifact `nexagnet-review-evidence`.
- Central Reviewer uses `Nexagnet V5 Legal Office Reviewer Caller` at `.github/workflows/claude-reviewer-caller.yml` for the pilot; its `workflow_run` HEAD points to **main**, not to the PR SHA. The run-scoped artifact is the source of the PR number and exact PR HEAD; do not infer either from the Reviewer run's own HEAD.
- Reusable Repair is deliberately **not** automatically active in any consumer while this R3 change remains unmerged.

## Trust boundary

1. A separately reviewed, SHA-pinned consumer Repair caller receives the completed **Reviewer** `workflow_run` event and uses a read-only discovery job to read the run-scoped artifact `nexagnet-review-evidence`. It binds `pr_number`, `expected_head_sha`, and `reviewer_run_id` to that artifact, **not** any PR comment or model self-report.
2. The central `gate` independently reads GitHub live data: event run ID, consumer Reviewer workflow exact configured name/path, default-branch source, publisher-bot PR author/branch, current PR HEAD, linked Task Contract and R0/R1/R2 risk, `autopilot:ready`, two-attempt cap, valid structured `REQUEST_CHANGES` evidence with `diff_inspected=true`, and successful exact-HEAD `ci` with exactly one matching PR association.
3. Claude Repair agent checks out the fixed PR HEAD using only a **read-only GitHub token**; bubblewrap subprocess isolation remains enabled. It can read/edit locally but cannot push or obtain the Publisher App private key. It emits a bounded untrusted patch.
4. Trusted `publish` job on a fresh runner rechecks current PR HEAD, Task Contract hash, risk, readiness, and forbidden paths/file types before minting a single-repository installation token. Git push is **fast-forward only on the same PR branch**, never force and never merge. New HEAD automatically invalidates old CI and Review.
5. Exact-head CI and the independent Reviewer must both run again on the new HEAD. If Reviewer returns another major/blocker, Repair is bounded by the maximum 2 repair commits for that PR; no unlimited loop.

## Remaining gates and runtime proof

- This workflow is **R3** and must not be deployed by standard Autopilot. Independent security review, owner-controlled merge, and exact-main CI are required.
- A **separate R3 consumer caller** must be introduced only after the central Repair SHA is merged and verified; no `secrets: inherit` or untrusted PR-triggered write token.
- Run a disposable synthetic negative case: Reviewer `REQUEST_CHANGES` at HEAD A -> trusted Repair on the same bot PR -> HEAD B -> exact-head CI on B -> independent Reviewer PASS on B. Capture actual PR, SHAs, run IDs and trusted artifacts. Also demonstrate a stale-HEAD rejection and max-two stop condition before marking Repair runtime-proven.
- This is **not** proof of auto-merge, product behavior, real customer records, deployment or production. V4 remains unchanged. A Reviewer PASS alone does not authorize merge.

## STOP conditions

Any issue touching R3 changes through Autopilot, production, secrets, App/ruleset/permissions, untrusted workflow caller, missing exact-head evidence, reviewer artifact mismatch, altered PR HEAD, protected paths, unsafe Git file modes, unlimited retries or merge without risk authorization must fail closed and escalate.
