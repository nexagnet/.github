# Nexagnet auto-onboarding — repository discovery (R3, partial implementation)

Canonical: https://github.com/nexagnet/.github/issues/5
Coordinator: https://github.com/nexagnet/nexagnet-platform/issues/447
Consumers: nexagnet/bmsl-website#112 and nexagnet/nexagnet-platform#470

## Implemented here

- GitHub-native scheduled workflow `.github/workflows/repo-discovery.yml` executes every six hours (and via workflow_dispatch) on the **central repository's default branch**. First job audits with `contents:read`; separate trusted job uses `contents:read` + `issues:write` restricted to its *central repository* to create canonical R3 onboarding tracking Issues when a consumer has no caller/CI. It never writes business code or workflow files.
- Workflow uses a **read-only GITHUB_TOKEN**; Node script `tools/repo-onboarding/audit.mjs` discovers GitHub-visible repositories in `nexagnet`, excludes control-plane `nexagnet/.github`, archived, forks and template repos, audits presence of expected caller files and CI, generates an untrusted JSON artifact and job summary.
- Discovery checks and canonical tracking-Issue creation are idempotent: dedupe against existing central markers and current consumer onboarding Issues, skip `.github` and noneligible repositories. Neither job creates workflow files, branches, PRs nor deploys. Protected repositories and private repositories hidden from the token are not silently considered onboarded.
- Both central unit tests and GitHub Actions syntax lint must pass on the exact PR HEAD.
- The separate ChatGPT New Repo Watch can also detect repos; it is outside GitHub. The GitHub-native tracker writes **one R3 tracking Issue** only if none exists, and can coexist with the Watch using live Issue checks. A tracking Issue is not automatic workflow creation.

## What is NOT implemented here

**This is discovery, NOT repo auto-activation.** A repository with every expected file is still only `CALLER_FILES_PRESENT_NOT_RUNTIME_PROVEN`, not ACTIVE.

The Publisher App installed with All repositories must **not** be given Workflows:write or Administration merely to bootstrap. `All repositories` covers current/future installation visibility, but does NOT add GitHub Actions workflow files to new repositories.

To achieve automatic onboarding for an arbitrary newly created repository:

1. Maintain an owner-reviewed, version-pinned repository template with minimal caller/CI files and hardened defaults. Template creation should be done in a separate R3 Task Contract/PR. A repo created from it receives the files immediately.
2. Implement an owner-approved **bootstrap control-plane**, separate from Publisher, that scans newly created repos or receives GitHub `repository.created` / installation events and reconciles missed events with a scheduled check. It must be able to create a **Draft R3 bootstrap PR** modifying `.github/workflows`, but **must not auto-merge that PR**.
3. Such a bootstrap mechanism needs permission to create workflow files. This is a **separate R3 owner security gate**; no App credential, token, webhook or infrastructure was created as part of this PR.
4. The new consumer caller must pin the merged central workflow's immutable full commit SHA and pass only explicitly approved secrets. Have no simultaneous V4 and new Claude workflows running for the same Issue or PR.
5. Verify real end-to-end Builder → CI → Reviewer → Repair → Autonomy and exact-main CI in the consumer before marking ACTIVE. R2/R3 owner merge gate and production authorization continue to apply.

## Coverage limitations and failure modes

- The current central GITHUB_TOKEN may see only public repositories. `coverage=GITHUB_TOKEN_VISIBLE_ONLY_NOT_GUARANTEED_PRIVATE_OR_ALL_REPOS` is deliberate. Repo metadata from App Publisher installation cannot be inferred through ChatGPT GitHub connector's separate installation.
- HTTP 403 or other unexpected read failures produce `UNKNOWN_ACCESS_NO_CONCLUSION` for that repo. Failed organization enumeration aborts; pagination >1000 repositories aborts rather than omit silently.
- No App secrets are available to this workflow and none are accepted as an input. Only the trusted tracking job has `issues:write` via scoped `GITHUB_TOKEN`; even this permission cannot create `.github/workflows` in a consumer repository.
- Workflow exists on a feature branch until owner R3 merge; scheduled events do not run from this unmerged branch. Do not claim that hourly ChatGPT Watch and six-hour native discovery are equivalent.
- No new repo is auto-bootstrapped by this partial implementation. Follow Issue #5 remaining acceptance criteria and do not close it prematurely.

## Rollback

Remove/disable this discovery workflow only by an owner-controlled R3 PR. It is read-only and does not change V4; no application deploy should be triggered by adding it.
