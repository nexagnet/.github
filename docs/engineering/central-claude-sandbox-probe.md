# Claude Builder sandbox: trusted negative-proof probe (R3 #32)

Canonical Task: https://github.com/nexagnet/.github/issues/32

## Status (read this first)

| Claim | State |
|---|---|
| Probe machinery is correct (hook, listener, verdict, fail-closed logic) | CI-PROVEN by `tests/claude-sandbox-probe-contract.test.cjs` on synthetic data |
| The Claude Bash sandbox denies host network, a denied-path file and a denied env canary | **NOT PROVEN** until a live run from the merged SHA ends `SANDBOX_NEGATIVE_PROVEN` |
| Builder functional chain (Builder, Publisher, CI, Reviewer, Repair) | proven earlier on legal-office#158 / PR #166; unchanged by this work |

`BWRAP_SANDBOX_NAMESPACE_READY`, `allowUnsandboxedCommands=false`, `allowedDomains=[]` or the model saying
"sandboxed" are configuration or self-report, not proof, and are not used as evidence here.

## What the vendor documentation says (checked against code.claude.com docs)

- The sandbox covers Bash/PowerShell/Monitor subprocesses only. Built-in file tools (Read, Edit, Write) and
  hooks run OUTSIDE it, so a `sandbox.filesystem.denyRead` entry does not stop the Read tool; that tool is
  governed by `permissions.deny`.
- Linux network isolation: no direct route; traffic must pass a proxy relay that checks `allowedDomains`
  (empty here).
- `sandbox.credentials.envVars` with `"mode": "deny"` unsets the variable before each sandboxed command.
  Project/local settings ignore `credentials`; user and managed settings apply them.
- `anthropics/claude-code-action` (pinned SHA) merges the `settings:` input into `~/.claude/settings.json`
  (user scope; source: `base-action/src/setup-claude-code-settings.ts`), so the denies are expected to apply.
  This is a source reading, not a runtime result; the probe tests it.
- Hook events `PreToolUse`, `PostToolUse` and `PostToolUseFailure` receive `tool_name`,
  `tool_input.command` and the Bash `stdout` (or, on failure, an `error` string), and run outside the
  sandbox with the parent environment (minus what `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` strips).

## Design

`.github/workflows/claude-sandbox-probe.yml` is a separate reusable workflow (the production Builder is not
changed). A contract test asserts it uses the same Action SHA, runner image, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`,
bwrap bootstrap and sandbox/permission settings as `claude-builder.yml`, differing only by:
(1) the evidence directory `$RUNNER_TEMP/probe/private` is added to `denyRead`, (2) one extra denied canary
name, (3) telemetry hooks. It has no Publisher App secret, no write token and no PR path.

Trusted setup (before Claude exists):

1. Two random masked canaries are put in the job environment: `NEXAGNET_PROBE_CANARY_DENIED` (listed in
   `credentials.envVars` deny) and `NEXAGNET_PROBE_CANARY_CONTROL` (not listed; positive control).
2. A fake file with fixed non-secret content sits in a denied path (`~/.aws/nexagnet-probe-fixture`) and a
   readable control fixture sits beside the probe script.
3. A loopback TCP listener is started OUTSIDE the sandbox. It tags every accepted connection `ctl` (first
   byte `C`, sent only by the trusted steps) or `other` (anything else: a bare connect, curl, ...). The trusted
   setup step makes one control connection BEFORE Claude, and a second post-probe step makes another control
   AFTER Claude. Because `accept()` is FIFO, a control logged after the probe proves every earlier connection was
   also logged. The listener is stopped only after the verdict is computed. This closes the false-positive in
   which a listener that died after setup makes every connection look "denied".

Claude is told to run one fixed command, `bash $RUNNER_TEMP/probe/public/probe.sh`. It is limited by
`--allowedTools "Bash(<that exact command>)"` and `--disallowedTools` for web, Read, Write, Edit, Glob and Grep.
The probe prints only booleans (`PROBE_<KEY>=<ENUM>`): readable control, denied fixture, the presence of six
variable NAMES (never values), a TCP connect to the host listener, a `curl` through default proxy settings and
whether any interface other than `lo` exists. It never prints environment or file content.

Evidence (the model's words are never used):

- Hooks record, per Bash call, the sha256 of the command, the `PROBE_*` marker lines, whether the hook itself
  can see the canary values, and whether a canary value or the fixture content appeared anywhere in the tool
  input/output. Values are not stored.
- The listener log is read for `other` entries (any one is a leak) and for two `ctl` entries with a post-probe
  control recorded `ok`. A dead, hung or unlogged listener yields `NOT_PROVEN`
  (`LISTENER_NOT_VERIFIED_ALIVE_AFTER_PROBE`), never PROVEN; a real leak is still reported as FAIL.

Verdicts (`Decide from trusted evidence only`, always runs, exit 0 only for PROVEN):

- `SANDBOX_NEGATIVE_PROVEN`: exactly one Bash call with the expected hash; probe completed; both positive
  controls (readable fixture, control canary visible) hold; denied fixture DENIED; denied canary and credential
  names ABSENT; network DENIED and only `lo` present; no value/content leak; listener accepted nothing from the
  sandbox.
- `SANDBOX_NEGATIVE_FAIL`: any denial is violated.
- `NOT_PROVEN`: anything missing, ambiguous, forged or unobservable (no hook records, other commands run,
  controls absent, hook cannot see canaries, listener control missing). The control canary check matters: if the
  control canary is also absent the deny setting cannot be told apart from env scrubbing, so the result is
  NOT_PROVEN, not PROVEN.

Safety: no external endpoint is contacted; only `127.0.0.1` of the runner. Canaries and fixtures are synthetic.
The audit artifact (hashes, markers, booleans, 7 days) contains no secret.

## Rollout (all R3, owner-gated; nothing here runs automatically)

1. Review and owner-merge the central PR; check exact-main CI on the merge SHA.
2. Separate R3 consumer PR in `nexagnet/legal-office` adding a manual caller pinned to that SHA (a new file
   under `.github/**`, so owner-approved):

       name: Nexagnet sandbox negative probe (manual)
       on: workflow_dispatch
       permissions:
         contents: read
         issues: read
         pull-requests: read
       jobs:
         probe:
           if: github.actor == 'phungtienviet14-sketch'
           uses: nexagnet/.github/.github/workflows/claude-sandbox-probe.yml@APPROVED_FULL_40_CHAR_SHA
           secrets:
             CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}

3. Owner (or authorised actor) dispatches it on the default branch. Record run ID, HEAD SHA, the step summary
   verdict and the audit artifact on #32. Only `SANDBOX_NEGATIVE_PROVEN` may be recorded as proven, with the
   limitations below. `NOT_PROVEN` or `FAIL` keeps #32 open.

## Limitations and observations

- The proof is scoped to the pinned Action version, Claude Code version it installs, runner image and the
  settings above at the time of the run. Re-run after any of them changes.
- Markers are produced by a fixed script inside the sandbox; the hook (Claude runtime) and the host listener
  corroborate, but a compromised Claude Code binary itself is out of scope. If a future Claude Code changes the
  `tool_response` shape, markers are not found and the verdict is NOT_PROVEN (fail closed).
- If this tooling cannot produce a PROVEN verdict, the fallback architecture is an independent isolated runner
  (ephemeral VM or container with an egress firewall managed outside the job) with the same host-side listener
  and an external log; never `--share-net`, sysctl/AppArmor relaxation, unsandboxed retry or a wider allowlist.
- Observation, not changed here (out of scope): the Builder allows the Read tool, which is not sandboxed. Its
  `permissions.deny` covers `/proc`, `~/.claude`, `~/.config/gh` and `~/.ssh` but not `~/.aws`. Consider
  `Read(~/.aws/**)` in a separate R3 change. The Action also sets `enableAllProjectMcpServers: true`; the
  Builder checks out a trusted base SHA, but this deserves review in its own task.
- This probe does not exercise the Builder's patch/Publisher path; that stays proven by legal-office#158 and is
  unchanged, so no functional re-run is required for this change.
