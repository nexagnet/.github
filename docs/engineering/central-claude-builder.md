# Nexagnet reusable Claude Builder — consumer integration

Canonical R3 issue: https://github.com/nexagnet/.github/issues/1
Coordinator: https://github.com/nexagnet/nexagnet-platform/issues/447
Draft PR: https://github.com/nexagnet/.github/pull/2

## Architecture

- Central workflow: nexagnet/.github/.github/workflows/claude-builder.yml
- Each repository needs its own small caller workflow. An organization .github repository is NOT an automatic listener for Issues across all repositories.
- Each caller must pin the shared workflow to its reviewed full 40-character commit SHA.
- Preflight runs with read-only GITHUB_TOKEN, no secrets. It validates a created Issue comment, the current GitHub actor, live Task Contract and exactly one risk R0/R1/R2. R3 is blocked.
- Claude runs in a separate job with a read-only GITHUB_TOKEN and explicitly passed Claude OAuth; it edits the local worktree only. The untrusted patch becomes a short-lived artifact; no branch push or PR from this job.
- A fresh trusted publisher job verifies the current base SHA, Issue/risk, patch application, protected paths and file modes. It does NOT execute artifact code.
- After validation only, a separately approved GitHub App token with limited permissions is minted. The publisher pushes validated changes to a new branch and opens a Draft PR. GitHub Actions/Reviewer/human owner remain separate merge gates.

## IMPORTANT: OWNER GATE — new GitHub App

Consumer secrets BUILDER_PUBLISHER_APP_ID and BUILDER_PUBLISHER_APP_PRIVATE_KEY are NOT provisioned by central Issue #1. A new owner-approved GitHub App must have only repository-scoped Contents (read/write), Pull Requests (read/write), and automatic Metadata read; NO Workflows, Actions, Administration, or org-wide access. Never blindly reuse the V4 App or add a long-lived PAT. The workflow must not be considered runtime-ready without this authorization.

The Claude OAuth secret must remain in each authorized consumer's GitHub Actions secrets, explicitly mapped through workflow_call. Do NOT use secrets: inherit by default.

## Consumer example (illustration only — NOT deployed)

Replace APPROVED_FULL_40_CHAR_SHA with a real reviewed immutable commit after the central R3 PR merges. Create an independent R3 Task Contract and PR for every consumer rollout.

    name: Nexagnet Claude caller
    on:
      issue_comment:
        types: [created]
    permissions:
      contents: read
      issues: read
      pull-requests: read
    jobs:
      builder:
        if: >-
          github.actor == 'phungtienviet14-sketch' &&
          github.event.issue.pull_request == null &&
          contains(github.event.comment.body, '@claude')
        uses: nexagnet/.github/.github/workflows/claude-builder.yml@APPROVED_FULL_40_CHAR_SHA
        with:
          issue_number: ${{ github.event.issue.number }}
        secrets:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          BUILDER_PUBLISHER_APP_ID: ${{ secrets.BUILDER_PUBLISHER_APP_ID }}
          BUILDER_PUBLISHER_APP_PRIVATE_KEY: ${{ secrets.BUILDER_PUBLISHER_APP_PRIVATE_KEY }}

## Security invariants and limitations

- Prompt instructions are not permissions. The read-only agent job and trusted post-validation publisher are the security boundaries.
- The event author allowlist is currently only phungtienviet14-sketch. Expanding to more users or bots requires independent security review.
- Protected-path validation is not a semantic business-scope validator. Independent Reviewer/human still compares PR code against Task Contract and verifies exact PR HEAD.
- Contract CI tests are not a proof that the official Claude Action produces local edits successfully with a read-only token. End-to-end consumer execution must be proven separately.
- The GitHub publisher App must trigger CI on the resulting PR (GITHUB_TOKEN-generated pushes are normally suppressed as workflow triggers).
- No central reusable Builder may merge, deploy, change secrets, or modify workflows.
- Rollback: disable the new consumer caller through a human-controlled PR and continue using V4. Retain V4 until Builder, Reviewer, Repair, merge and runtime evidence reach parity.
- Cross-repo proof: consumer Issue -> verified event -> Builder job -> validated Draft PR -> CI on exact HEAD -> independent review -> owner merge -> CI on exact main SHA.
- Public central repository must contain no credentials, private customer data or installation keys.

## Status

CENTRAL-SOURCE-VALIDATED requires exact-head tests and independent review.
CENTRAL-MERGED requires owner merge plus exact-main evidence.
CONSUMER-RUNTIME-PROVEN additionally requires an approved publisher App, consumer caller and live proof.
V4-RETIRED is a separate final phase, not achieved by this PR.
