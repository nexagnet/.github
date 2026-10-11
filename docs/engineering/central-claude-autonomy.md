# Nexagnet Shared Autonomy — R3 guarded merge design

Canonical: https://github.com/nexagnet/.github/issues/8
Dependencies: Builder #1 / Reviewer #4 / Repair #7 and Publisher #3.
Owner-controlled R3 implementation and merge; this runbook does not authorize production.

## Merge policy

- Preflight only runs for trusted Reviewer caller workflow_run and downloads structured run-scoped Reviewer artifact. PASS must match current PR exact HEAD, Issue, risk and current successful CI run with all configured required job names.
- Same repository, default target branch, publisher bot author and issue-scoped branch required. Control-plane / workflow / infra / secret paths disallowed. PR file list >99 blocks.
- Exactly one risk:R0/R1/R2, nonempty Task Contract headings and autopilot:ready required; R3/missing/conflicting risk blocks.
- **R0/R1:** Issue also requires explicit \`autopilot:auto-merge\` opt-in label to reach the privileged merge job. Without this label NO_AUTOMERGE.
- **R2:** NEEDS_OWNER comment, no merge token; owner manual merge only.
- **R3:** BLOCK, never an Autopilot entry point.
- A separate \`AUTONOMY_MERGE_APP_ID\` / \`AUTONOMY_MERGE_APP_PRIVATE_KEY\` installation with Contents R/W and Pull requests R/W is required. This merge authority is deliberately NOT the Builder Publisher App. App creation/installation and secrets remain OWNER R3 GATE.
- Only after revalidating SHA, risk and labels does the merge job mint the token. It marks Draft PR ready and calls GitHub CLI native \`gh pr merge --squash --match-head-commit SHA\` **immediately**, without \`--admin\` or branch-rule bypass. Delayed \`--auto\` is FORBIDDEN: an opt-in label might be revoked while the merge is pending.
- The pre-merge gate fetches **effective rules for the target branch**, fails if rules are unavailable/empty, requires status-check or PR protections, and rejects any merge-queue rule. GitHub's immediate merge must fail if current requirements are not satisfied. Because no delayed merge is scheduled, opt-in label revocation after a prior run cannot trigger a future merge request. Success of the CLI call is NOT proof of merge SHA, exact-main CI, deploy or runtime; independently re-fetch.
- Merge receipt must be independently verified live; after actual merge, check merge SHA and exact-main CI and required runtime proof. A separate watchdog/coordinator can track that.
- Do not enable this on a consumer where V4 Autonomy is still evaluating the same PR, to prevent competing merge engines.

## Example consumer caller (NOT DEPLOYED)

Consumer must run default-branch \`workflow_run\` from \`Nexagnet Reviewer caller\`; event is signal only, the reusable workflow re-fetches all evidence. Obtain PR number/head SHA from trusted Reviewer evidence; never use the reviewer's workflow_run default-branch SHA as PR HEAD. The caller path must be \`.github/workflows/nexagnet-claude-autonomy.yml\` and must pin reviewed immutable central 40-character SHA. Supply explicit repository-scoped merge App secrets; never use \`secrets: inherit\`.

## Evidence / owner gates

The R3 central source is not runtime-proven by actionlint/security-contract tests alone. Before enabling in a consumer: parent R3 owner-merged, exact-main CI, independent audit, separate merge-App credential authorized, consumer caller R3 owner merge, test R0 auto-merge and R1 stale-head denial, R2/R3 human gates, and actual merge SHA + exact-main CI after real merge. No secrets or production were modified by the central PR.
