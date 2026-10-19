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
        # Cheap pre-filter only; the central preflight is the authority. GitHub
        # expression string comparison is case-insensitive and cannot trim, so this
        # is intentionally stricter-or-equal: whole-body match of the two commands.
        # Do NOT declare `concurrency:` here: the called workflow owns the group.
        if: >-
          github.actor == 'phungtienviet14-sketch' &&
          github.event.sender.type == 'User' &&
          github.event.issue.pull_request == null &&
          contains(fromJSON('["@claude","@claude retry"]'), github.event.comment.body)
        uses: nexagnet/.github/.github/workflows/claude-builder.yml@APPROVED_FULL_40_CHAR_SHA
        with:
          issue_number: ${{ github.event.issue.number }}
        secrets:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          BUILDER_PUBLISHER_APP_ID: ${{ secrets.BUILDER_PUBLISHER_APP_ID }}
          BUILDER_PUBLISHER_APP_PRIVATE_KEY: ${{ secrets.BUILDER_PUBLISHER_APP_PRIVATE_KEY }}

## Owner command syntax, retry policy and duplicate protection (R3 #33)

Only two comments start a Builder, and only when the WHOLE comment is exactly the
command (trailing whitespace ignored; leading text, other lines, code spans, fences,
quotes, bold, links, case variants, `@claudette`-style look-alikes never match):

| Comment | Meaning | Accepted when |
|---|---|---|
| `@claude` | First attempt | no earlier owner command on the Issue AND no Builder PR (any state) in `claude/issue-<N>-*` |
| `@claude retry` | Sanctioned retry after `BLOCKED` / `NO_PATCH` / a closed-unmerged Draft | at least one earlier command, fewer than 3 earlier commands, no open and no merged Builder PR |

A report that merely mentions `@claude` is never a command. Bot or app comments, PR
threads, edited comments and workflow re-runs (`run_attempt > 1`) are rejected. The
live comment is re-fetched and must match the event (same id, human `User` owner, same
body). Authority is checked twice: a cheap consumer pre-filter, then the trusted central
preflight (the pre-filter is never the security boundary).

**Attempt ledger.** The ledger is the owner's own earlier command comments on the Issue
(human `User` author, exact command body), paginated, ordered by comment id. A rejected
duplicate command still consumes budget, so the cap of 3 attempts per Issue is
auditable from the comment thread alone. A revised Task Contract is a new Issue. The owner
could delete command comments to reset the ledger; that is an owner-controlled act, not an
automation path.

**Duplicate-PR guard.** `bot_pr_guard` lists all same-repository PRs (all states, fully
paginated, `per_page=100`) whose head branch matches `claude/issue-<N>-<run>-<attempt>`,
the exact shape Reviewer and Repair already parse. Forks and other Issues never match.
Any 403, rate-limit or unparsable page fails closed. It runs (1) in preflight,
(2) in the publisher with the read-only token before any write token is minted and
(3) again immediately before the first push with the write token. Repair keeps pushing
to the same PR branch, so an open repaired PR keeps blocking new commands.

**Concurrency and what it does and does not guarantee.** The reusable workflow declares one
workflow-level group, `nexagnet-builder-<repo>-issue-<N>`, `cancel-in-progress: false`.
Callers and child jobs must not reuse that name (self-cancel/deadlock). GitHub keeps one
running plus one pending run per group and cancels further pending runs, ordering of pending
runs is not guaranteed, and the lock does not cross repositories. Therefore correctness does
not depend on it. Two publishers that pass every check before either PR exists are resolved
by a deterministic tie-break: after creating its Draft each publisher lists the namespace and
the lowest open PR number wins; every other publisher closes only its own PR, deletes only
its own branch and fails the run. Residual risk: that tie-break assumes GitHub's PR list is
read-your-own-write consistent; if it is not, `PUBLISH_STATE_UNKNOWN` fails the run and a
human closes the extra Draft (never merged: Drafts need Reviewer, exact-head CI and the owner).

Audit trail: the PR body records `command`, `attempt` and the trigger comment URL.
Rejections are single-line `::error::` codes: `INTENT_REJECTED`, `REPLAY_REJECTED`,
`COMMENT_CHANGED`, `DUPLICATE_COMMAND_REJECTED`, `EXISTING_PR_REJECTED`,
`RETRY_WITHOUT_ATTEMPT`, `RETRY_BUDGET_EXHAUSTED`, `OPEN_PR_REJECTED`,
`MERGED_PR_REJECTED`, `PR_LOOKUP_FAILED`, `LEDGER_LOOKUP_FAILED`,
`DUPLICATE_PR_REJECTED`, `DUPLICATE_PUBLISH_RACE_LOST`.

Consumers on an older pinned SHA keep the old substring behaviour until they re-pin in a
separate, owner-approved R3 consumer PR.

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
