# Central Claude Repair — R3 implementation and trust model

Canonical Issue: https://github.com/nexagnet/.github/issues/7
Parent dependencies: Builder #1/PR #2; Reviewer #4/PR #6.

## Implemented

- Reusable \`.github/workflows/claude-repair.yml\` with 3 jobs: \`gate\`, \`agent\`, \`publish\`.
- \`gate\` consumes **workflow_run from the trusted consumer Reviewer caller** on the default branch and verifies its workflow name/path/run conclusion using GitHub API.
- Downloads \`nexagnet-review-evidence\` from that precise run. The Reviewer reporter creates this artifact only after re-fetching HEAD, Issue, risk and CI. It binds \`head_sha\`, \`pr\`, \`issue\`, \`ci_run_id\`, \`risk\` and machine-structured Reviewer verdict. The Repair accepts \`REQUEST_CHANGES\` with actual blocking/major finding only.
- Limits total prior \`repair: validated issue\` commits to 2 per PR; uses PR-scoped concurrency, same-repository bot author/branch provenance and exact HEAD.
- Untrusted Claude runs on a read-only GitHub token (no OIDC, no publisher App key); only outputs a patch artifact.
- A fresh publisher applies and validates the patch without executing app code, denies control-plane/secrets/unsafe modes, then mints an installation token scoped to the consumer repository. Updates the **same PR** with fast-forward-only push; never merges or deploys. CI and Reviewer must rerun on new HEAD.

## Consumer caller (illustration, NOT deployed)

Consumer needs a separate owner-controlled R3 PR, pinned central SHA and exact known workflow run source. Only create caller after Builder/Reviewer/Repair parent PRs have been reviewed and merged. Recommended file name: \`.github/workflows/nexagnet-claude-repair.yml\`; canonical Reviewer caller name: \`Nexagnet Reviewer caller\`. Its event must be \`workflow_run\` for that Reviewer workflow, completed; exact reviewer run ID, PR, and HEAD must be recovered from trusted Reviewer result rather than guessed from the workflow_run head SHA (which is the consumer default branch for this caller).

The current workflow does NOT infer consumer PR number/SHA directly. It requires \`pr_number\`, \`expected_head_sha\` and \`reviewer_run_id\` from a separately validated caller/dispatcher. Do not use an untrusted comment body to supply them.

## Proof not yet obtained / blockers

- No consumer has a new SHA-pinned caller or configured Publisher secret in use; owner-reported App installation is not permission/credential runtime proof.
- No Claude OAuth or App publication executed; the new workflows have only source-contract/actionlint test coverage.
- No actual same-PR Repair on consumer A -> B, independent Reviewer on B, or max-two/HEAD-race live tests.
- V4 Reviewer/Repair/Autonomy must remain intact. Avoid simultaneously running both pipelines on the same PR.
- GitHub token permission and authentication semantics must be validated end-to-end; do not claim source tests prove secret isolation.
- Exact R3 human merge, exact-main CI and non-production runtime proof remain mandatory.

## Fail-closed design

An unverified Reviewer workflow run, stale or malformed artifact, missing/closed Issue, risk R3, changed PR HEAD, non-publisher branch, retry count >=2, forbidden path or missing Publisher permission must stop without a push. No force push, no auto-merge, no production.
