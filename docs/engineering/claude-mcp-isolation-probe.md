# MCP startup synthetic runtime diagnostic (#37)

This is separately reviewed diagnostic source. It neither merges PR43 nor changes
the production Builder or the legal-office main caller. Only an owner-dispatched,
reviewed diagnostic branch and its exact SHA may call the reusable workflow.
The required input is `expected_consumer_sha`; the workflow fails unless it equals
the actual 40-character `github.sha`. Actor, repository, event and branch are fixed.

## What is measured

Two actual invocations of the pinned Claude Code Action run on Ubuntu22.04 with
read-only GitHub permissions and the existing explicitly mapped Claude credential.
Each uses a fresh synthetic HOME. No real credential paths are inspected.

The control invocation omits strict MCP flags. Four benign stdio fixtures are
declared through project `.mcp.json`, local/user `.claude.json`, and an explicitly
loaded local plugin. Every source must really start, complete `initialize` and
answer `tools/list`. Directly running a marker script cannot satisfy this control.
The CLI init event must report all four connected servers, and a real Read call
must retrieve a harmless positive-control file. The fixture processes only speak
JSON-RPC and append source/phase/event/PID records; they never read environment,
spawn commands or contact network services. Owned control processes are stopped
after identity checks before the candidate begins.

The candidate uses PR43's `--setting-sources user --strict-mcp-config` with an empty
central MCP configuration. The four synthetic sources remain planted, including
an explicit plugin-dir stress case. Proof requires successful actual Action
initialization, the useful Read control, an empty native `mcp_servers` list, and
zero candidate process markers. The phase-specific fixtures prevent late control
events from masquerading as candidate results. Account-provided connectors are
disabled with `ENABLE_CLAUDEAI_MCP_SERVERS=false` in both phases.

The sandbox stays enabled, fail-if-unavailable, no unsandboxed commands, and an
empty allowed-domain list. Bash/model mutation/web tools are denied. Model Read
is denied to `.git`, the host audit, auth configuration, process environment and
the raw SDK execution file. Startup marker instrumentation does not deny startup
itself; it only observes the real processes that the pinned CLI launches.
A separate trusted PreToolUse guard returns a neutral result only for the exact
synthetic Read file and denies other tool invocations. It bounds the diagnostic's
tool surface; it does not grant a native Read permission or participate in MCP
configuration/startup. This guard is not evidence for native Read path denial.

## Verdict and evidence

The Action's `execution_file` is parsed by trusted host code and immediately reduced
to counts/booleans. Raw model/tool messages are never logged or uploaded. The
`mcp-isolation-audit` artifact contains only the bounded sanitized verdict report.

- `MCP_STARTUP_NEGATIVE_PROVEN`: every source has a successful discovery control,
  owned controls stopped, actual candidate useful execution completed, native MCP
  list empty and candidate process event count zero.
- `MCP_STARTUP_NEGATIVE_FAIL`: a candidate fixture starts or a server is discovered.
- `NOT_PROVEN`: any missing/duplicate/ambiguous control, missing report, unexpected
  tool, failed Action, or unverified shutdown. A missing marker alone is not proof.

Local tests run the actual inline verifier with fault injection and the generated
stdio fixture protocol. They are machinery tests, not actual CLI runtime proof.
The host measures each phase's installed executable with `--version`; the sanitized
audit records both versions. Any missing version or mismatch from `2.1.293` yields
`NOT_PROVEN`, even when all startup controls pass.

Runtime acceptance needs exact central/consumer SHAs, run ID, installed CLI version,
sanitized artifact/hash, all control outcomes and independent evidence review.

This establishes only observed startup behavior for these four source fixtures,
the tested plugin-dir stress case and pinned runtime. It does not establish MCP
tool authorization, external network/credential isolation, Figma authorization,
or account/cloud/desktop connector behavior. Public Internet and Figma stay disabled.

Primary references: pinned Action `base-action/src/run-claude-sdk.ts` and
`base-action/src/execution-file.ts` at `6fed3ca145920b639991cb756090506e1bcaf515`;
the [official MCP connector control](https://code.claude.com/docs/en/mcp#disable-claude-ai-connectors)
and [official plugin structure](https://code.claude.com/docs/en/plugins-reference).
