# Read, Glob and Grep runtime diagnostic (#36)

Status: source implemented; actual native-tool isolation is **NOT_PROVEN** until
the reviewed diagnostic runs and its sanitized evidence is inspected. This does
not merge PR42, change the production Builder or enable Internet/Figma.

## Authorization and test target

The reusable `.github/workflows/claude-read-isolation-probe.yml` accepts only an
explicit existing Claude OAuth secret and a required expected consumer SHA. Its
gate checks owner `phungtienviet14-sketch`, repository `nexagnet/legal-office`,
manual dispatch, the fixed `codex/tool-isolation-runtime-36-37` branch, and exact
`github.sha`. Root must review and freeze the caller/central source SHAs before
dispatch. It is a separately authorized unmerged diagnostic, not a consumer
rollout or permission to merge either candidate implementation PR.

The Action runs with a synthetic HOME under the runner's temporary directory.
Only that home's fake `.aws` tree is probed. The real runner/user credential paths
are not used as test fixtures. This allows `Read(~/.aws/**)` to be measured without
placing actual AWS credentials in the diagnostic. Bash, writes, web, task agents
and MCP are unavailable to the model; strict Bash sandbox settings remain enabled.
Account-provided MCP connectors are disabled with `ENABLE_CLAUDEAI_MCP_SERVERS=false`.
Workspace `.git` is explicitly Read-denied because the Action may configure its
read-only GitHub credential there; the diagnostic never inspects that directory.

## Native evidence, not model assertions

The pinned Action is `anthropics/claude-code-action@6fed3ca145920b639991cb756090506e1bcaf515`,
whose launcher installs CLI2.1.293. The host verifies the installed executable's
version. At that exact pin, `base-action/src/run-claude-sdk.ts` retains the complete
SDK message array in `execution_file` even when `show_full_output=false` prints
only a sanitized result. The output is propagated by `action.yml`.

The trusted verifier reads this local transcript without printing or uploading
it. It pairs actual assistant `tool_use` records with user `tool_result` records,
and identifies native denials by the final SDK result's `permission_denials`
entries with matching tool name, input and tool-use ID. A safety PreToolUse guard
denies calls outside the seventeen exact tool/input pairs in the private manifest.
For planned pairs it returns `{}` without any allow or deny decision, leaving
native permission evaluation authoritative. Guard denials are never native proof.

The original fifteen cases cover Read, Glob and Grep: one readable positive control per
tool and four denied targets per tool (home-relative, absolute, symlink and `..`
alias). Each alias uses a distinct fixture directory so evidence remains
attributable. Calls are exact and occur once; missing, duplicate or unexpected
calls fail closed. The host independently checks fixture contents and symlink
target before accepting results. Positive Read/Grep responses must contain the
unpublished random control marker; Glob must identify the control file. Two additional
Read controls use `~/public/control-home.txt` and the synthetic HOME's
`public/step/../control-normalized.txt`. Both have distinct readable fixture files,
and the intermediate `step` directory exists. The original negative inputs, including
their literal `~` and `..`, remain unchanged.

`READ_ISOLATION_PROVEN` requires all five controls and twelve authoritative native
denials with a successful Action/result and the expected CLI. Each accepted negative
also requires exactly one correlated `is_error=true` tool result and one valid neutral
guard audit record. A missing result cannot establish native-policy proof. A filtered-empty
Glob/Grep result, a generic failure, missing denial ledger, skipped alias or tool,
ambiguous result, unexpected version, or unsuccessful Action is `NOT_PROVEN`.
Denied synthetic content in any raw message or a successful Glob result exposing
the denied file gives `READ_ISOLATION_FAIL`, even alongside a denial record.

## Evidence and limits

### Guard audit and proof schema v2

The guard writes one bounded private JSONL record before returning its decision.
The audit file starts empty with mode 0600 under the existing private directory.
Appending uses a bounded exclusive lock and a single `O_APPEND` write, rejects
symlinks/nonregular files, and fails closed on audit I/O or locking errors. The
Ubuntu path also enforces ownership and `O_NOFOLLOW`; Windows tests exercise its
equivalent serialized append behavior. Audit records retain only a SHA-256 of the
actual tool-use ID, tool/decision enums, exact/expanded manifest indices and alias
booleans. They contain no raw ID, input, path, fixture content or exception text.

The trusted verifier binds each audit hash to the actual SDK call and requires its
exact manifest index and tool to match that call's case. An audit neutral for some
other case is insufficient. Missing, duplicate, malformed, unknown-ID or denied
audit evidence prevents that case from receiving `NATIVE_DENIED` credit; invalid
audit input fails the overall proof closed. Explicit guard-denial/error results
and available SDK hook-response errors or decisions also prevent native-policy
credit, including a failure after a neutral audit append. The verifier does not
assume that SDK hook stdout is always available. Exposure detection retains FAIL
priority even when audit evidence is absent or invalid.

Sanitized `guard_diag` fields contain booleans and capped counts only. They identify
whether the hook saw an exact planned input, an expanded variant, and whether its
decision was neutral or denied. Expansion comparison remains observational: it
never changes guard neutrality or the exact native ledger acceptance rule. This
distinguishes a guard intervention before native permission evaluation from a
later ledger representation mismatch without claiming either as successful proof.

This version emits `nexagnet-read-isolation-v2`: 17 cases, five positive controls
and mandatory guard audit. Earlier v1 artifacts have 15 cases and no audit and
must not be reinterpreted as satisfying v2. Re-run only the reviewed, immutable
source/caller after exact-head CI; preserve prior artifacts and their original
verdicts. No production Builder or MCP workflow change is part of this migration.

Only `read-isolation-proof` is uploaded: bounded case IDs, tool names, counts,
native-denial booleans, guard diagnostic flags/counts, outcome enums, static failure reasons, run ID and SHA.
It contains no fixture value, file content, raw tool response, actual token or
transcript. Raw audit JSONL and its ID hashes are not uploaded. The raw execution file and private manifest remain local and are
explicitly denied to Read. Artifact retention is seven days.

Verifier failures include bounded stage and error-class enums, never exception
messages, paths or transcript data. SDK system/progress messages are excluded
from tool-content parsing; assistant/user evidence still follows the strict
case, response and native denial requirements above.

Record caller and central SHA, Action/CLI version, run URL, sanitized artifact
ID/digest, verifier verdict and independent review on canonical #36. Preserve
per-tool and per-alias gaps rather than collapsing them into a security PASS.
The test suite executes the actual embedded Python verifier against synthetic SDK
records, including missing/duplicate calls, filtered-empty results, false controls,
content exposure, mismatched denial identity, malformed matrix and conflicting
results. Those regression tests validate machinery, not actual CLI behavior.

This probe does not prove arbitrary subprocess, MCP, all credential, SSRF or
cross-process isolation. It does not alter Publisher credentials, GitHub write,
production/customer access or merge policy. PR42 remains Draft/unmerged.
