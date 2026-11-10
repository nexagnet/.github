# Claude Builder Cloud Capabilities — Phase 0 Feasibility and R3 Architecture Decision

Status: **PROPOSED / NOT MERGED / NO EXTERNAL AUTH OR RUNTIME PROOF**  
Canonical Issue: https://github.com/nexagnet/.github/issues/38  
Baseline verified 2026-10-22: nexagnet/.github main **0d253050b996ce7bf5a08a3728f3b1dc97445656**  
Security dependencies: [#36](https://github.com/nexagnet/.github/issues/36), [#37](https://github.com/nexagnet/.github/issues/37), [#32](https://github.com/nexagnet/.github/issues/32). Visual review dependency: [#22](https://github.com/nexagnet/.github/issues/22).

## Decision

**Adopt a two-lane, official-first design rather than removing V5 sandbox boundaries.**

- **Code Builder lane:** keep Claude capable of reading/editing code, running sandboxed commands, generating an untrusted patch; privileged Publisher remains a separate clean job and only creates a Draft PR. Add centrally approved *read-only* research and deterministic dependency acquisition before considering unrestricted agent egress.
- **Connected tool lane:** add an independently authorized, explicitly scoped, short-lived tool execution job or approved integration worker for third-party MCP access and external effects. The code-builder's generic Issue/comment text must never create authorization for MCP or mutate Figma.
- **Figma:** use the official remote Figma MCP with a supported Claude Code client and Figma-provided skills **only after** unattended authorization is demonstrated on a disposable GitHub runner. Until proven, keep Figma interaction in an authenticated human-started session. Never copy desktop cookies, internal Claude OAuth stores or personal browser sessions into GitHub Actions.
- **External writes:** Figma design changes occur outside git diff/publisher validation and are persistent immediately. Treat as an independent approval and audit boundary, not as an ordinary R0/R1 code patch.

This is an architecture direction, **not** authorization to enable any network, add secrets, write Figma files, change consumer workflows or auto-merge R3.

## Observed baseline (not assumptions)

| Area | Current evidence | Status |
|---|---|---|
| Central Builder | workflow_call; readonly preflight; sandboxed Claude on Ubuntu 22.04; fresh trusted Publisher | Present on main |
| Network | sandbox.network.allowedDomains = []; Bash checked with Bubblewrap --unshare-net; prompt requires no network; WebFetch and WebSearch denied | Restricted by configuration; full negative proof tracked in #32 |
| Tools | Read, Glob, Grep, Edit, Write, Bash; no explicit custom Figma MCP or centrally authorized third-party capability profile | No authorized Figma tools |
| Tokens | Claude OAuth is provided to Action; GitHub agent permissions are read-only; Publisher App token minted after patch validation in a different job | Source-level separation; credential non-Bash tool proof tracked in #36 |
| Project MCP | Action documentation reports enableAllProjectMcpServers is set true; an existing project MCP may load despite a protected patch path | **Potential effective-tool boundary; investigate exact pinned action under #37** |
| Figma remote MCP | Official endpoint https://mcp.figma.com/mcp; remote server supports read and native write via use_figma | Supported for authenticated Claude Code |
| Figma authentication on ephemeral CI | Figma setup documentation describes interactive browser OAuth; no verified unattended bootstrap/refresh mechanism for this V5 runner | **NOT PROVEN** |
| Figma design mutation | use_figma can create/edit/delete arbitrary native content accessible to authenticated principal | Requires separate design isolation and approval |
| Consumer rollout | legal-office has pinned V5 caller; platform and bmsl-website still have their own Autopilot V4 workflows | Not organization-wide |

### Primary vendor references

1. Anthropic Action custom MCP, secrets, project-MCP caveat: https://github.com/anthropics/claude-code-action/blob/main/docs/configuration.md
2. Anthropic base-action project-trust warning: https://github.com/anthropics/claude-code-action/blob/main/base-action/README.md
3. Figma official remote MCP and interactive OAuth: https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/
4. Figma native write and beta safeguards: https://developers.figma.com/docs/figma-mcp-server/write-to-canvas/
5. Figma MCP tools, including use_figma (native modifications): https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/
6. Figma availability and seat restriction: https://developers.figma.com/docs/figma-mcp-server/

Vendor pages may change. The action used on this Nexagnet main is pinned to **anthropics/claude-code-action@6fed3ca145920b639991cb756090506e1bcaf515**; a current main-branch vendor document does **not** prove the exact behavior of that pinned source. Issue #37 must compare the pinned implementation and executable runtime.

## Threat model and non-negotiable boundaries

Threat sources: Task Contract/Issue/comments, repository source, project .mcp.json, CLAUDE.md, tool output, fetched webpages, dependency post-install scripts, Figma canvas content and external MCP responses.

1. Task prose and repo content are untrusted DATA, never instructions that can grant privileges or change effective MCP/server permission.
2. Never enable all project-defined MCP processes for an untrusted builder by default. The central trusted configuration must exclusively choose approved servers and per-tool allowlists; **verify effective runtime behavior** with a synthetic process-spawn canary (#37), not a grep of YAML.
3. A model-level instruction to stay within fileKey is **not an access-control boundary**. Figma MCP tools can execute stateful operations on any resource accessible to the authenticated Figma account. Use provider ACL with a dedicated limited-access identity / isolated draft where supported, or a policy-enforcing authorized intermediary with negative tests. If neither can be demonstrated, **do not provide unattended Figma write**.
4. Agent Bash, Read, MCP process, plugins and Skills can have *different* access mechanisms. Prove denial for each trust surface (#36/#37); a Bubblewrap Bash network namespace is not sufficient evidence for a separate MCP process or non-Bash Read tool.
5. Never pass GitHub Publisher App private key, GitHub write token, Figma OAuth refresh/access token or customer/production credentials to the untrusted Claude worktree, shell or tool output.
6. Read-only web access still introduces prompt injection and data exfiltration opportunities. Use bounded egress, DNS/redirect/private-IP controls, request/response size limits, audited destinations and policy enforcement outside the model. A bare hostname allowlist does not restrict HTTP methods or operations.
7. Third-party writes need owner-approved target and scope, before/after evidence, idempotent retry plan, stop on ambiguous state, and independent review. Draft Figma copies are preferred; production design systems remain protected.
8. No Builder merge, deploy, secret/config updates, security-policy changes or GitHub write from Claude's agent job. GitHub truth remains Issue → exact HEAD CI → Reviewer → risk merge → exact-main CI → runtime proof.

## Capability contracts: proposed, NOT deployed

| Profile | Authority | Safe execution locus | Evidence |
|---|---|---|---|
| code:local | Read/edit/test within approved repo paths | Sandboxed code Builder (no publish token) | Untrusted patch, local check summary |
| research:public-read | Bounded read of official docs | Trusted fetcher or audited constrained egress | URL, content hash, timestamp, redaction record |
| dependencies:locked | Fetch vetted lockfile packages, ignore lifecycle scripts | Trusted deterministic preparation | Frozen-lockfile logs, integrity/hash |
| figma:read | Read one explicitly authorized design/draft | Authenticated integration worker if provider auth supports | File ID, tool name, run ID, read-only audit |
| figma:write:draft | Mutate only the explicitly approved disposable draft | Separate authorized integration worker, **after owner approval** | Provider ACL, tool audit, before/after screenshot/URL |
| integration:staging | Test with synthetic noncustomer data | Dedicated restricted CI job | Exact SHA, runtime evidence |
| prod / credentials / infrastructure | Not delegated to Builder | Human-controlled separate workflow | Explicit owner authorization |

**No free-form CAPABILITIES string in an untrusted Issue may change workflow permissions.** An Issue may request capabilities; trusted policy resolves whether a profile is allowed on that repository, for that target, under this risk classification.

## Authentication feasibility decision tree

1. Confirm whether Figma documents and supports a noninteractive authorization suitable for official remote MCP on *fresh ephemeral GitHub runners*, including credential renewal, token scope, revocation and rate/billing implications.
2. If documented, verify in a disposable integration environment under an explicit owner authorization, keeping secrets in the dedicated worker only; run read-only first.
3. If undocumented or incompatible, status remains **BLOCKED: FIGMA_HEADLESS_AUTH_UNPROVEN**. Do not infer PAT equivalence, export browser cookies or copy ~/.claude auth state.
4. Alternative: human-started Claude Code/Desktop session already authenticated to Figma; it can create draft design and link evidence to GitHub, while GitHub Builder remains responsible for code. Another alternative is an officially supported provider integration/API **only if** it offers needed operations and authentication.
5. If read works, test write only in a duplicate draft with a principal that cannot access unrelated files, *then* evaluate any broader rollout; never make a production Figma file the first test.

Figma's setup documents interactive login. This research has **not** located vendor-confirmed GitHub Actions headless provisioning for the remote MCP. This absence of evidence is not proof that such a feature cannot exist.

### Authentication recheck — 2026-10-22

Status: **FIGMA_HEADLESS_AUTH_NOT_PROVEN**. The official
[remote setup](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/)
still requires account sign-in and consent in a supported client. Anthropic's
[MCP authentication reference](https://code.claude.com/docs/en/mcp#authenticate-with-remote-mcp-servers)
requires initial interactive authorization. Its no-browser login still needs a
human to open an authorization URL and paste a callback into a terminal.
Automatic refresh of an existing authorized session does not establish secure
bootstrap or renewal on a fresh ephemeral runner. Supplying an OAuth client
secret configures a client; it does not replace the user's authorization grant.
No Figma-specific supported service credential, unattended renewal or file-scoped
MCP token has been established by this investigation. No account authentication,
credential export or Figma tool call was attempted.

Supported fallback: an explicitly authorized, human-started Claude Code or Codex
session reads an approved disposable Figma file and supplies design evidence to
the GitHub workflow. This remains an interactive integration, not headless cloud
authentication. Figma's [canvas documentation](https://developers.figma.com/docs/figma-mcp-server/write-to-canvas/)
requires edit access and recommends duplicate/draft testing. Neither a supplied
file URL nor a prompt restricts the account's other resource permissions.
Owner consent and an approved test target are required before that separate
pilot; a write pilot additionally needs explicit draft-write authorization and
provider/policy-enforced negative cross-file proof.

## Implementation checkpoint — 2026-10-22

Live central main remains `0d253050b996ce7bf5a08a3728f3b1dc97445656`.
Accessible organization repository inventory contains `.github`, `legal-office`,
`nexagnet-platform`, and `bmsl-website`. The legal-office Builder caller pins that
central SHA; its Reviewer caller separately pins
`7166e745607860e6f8a414548963f83d12c71f9b`. The other two application repositories
still contain V4 Autopilot workflows. No consumer caller or V4 fallback was changed.

| Work item | Reviewable source | Proven / outstanding |
|---|---|---|
| #36 non-Bash credential path | Draft [PR #42](https://github.com/nexagnet/.github/pull/42), `212de4f3439df370876a6611ec0f9fb67444320f` | Explicit AWS Read denial; independent source review; [exact-head CI](https://github.com/nexagnet/.github/actions/runs/39743840559) 44/44 PASS. Actual Read/Glob/Grep denial NOT_PROVEN; not merge-ready. |
| #37 project MCP startup | Draft [PR #43](https://github.com/nexagnet/.github/pull/43), `26d123f73719cb8b74760274b46f77bcf52fbb6f` | Exclusive empty central MCP config and trusted user settings only; independent source review; [exact-head CI](https://github.com/nexagnet/.github/actions/runs/39743893359) 46/46 PASS. Actual Action marker startup proof NOT_PROVEN; not merge-ready. |
| #32 negative evidence | Existing [PR #35](https://github.com/nexagnet/.github/pull/35), `0fcb132864bc64fcf9811dc82a3d6c435decf0d3` | Reused existing listener repair; added exact marker inventory and explicit credential outcomes so missing/duplicate/conflicting observations cannot yield PROVEN. Independent source review and [exact-head CI](https://github.com/nexagnet/.github/actions/runs/39744261336) 64/64 PASS. Actual Claude sandbox test still required. |
| #22 visual Reviewer | Draft [PR #44](https://github.com/nexagnet/.github/pull/44), `2ef2509b07fffc6015a95b34b581df062ab04049` | Trusted UI detection, frozen PR/base-spec context, deterministic REQUEST_CHANGES while image transport is NOT_VERIFIED. Independent source review and [exact-head CI](https://github.com/nexagnet/.github/actions/runs/39744601169) PASS. No visual comparison or Figma parity PASS claimed. |
| #40 public egress | Existing Issue, no network enabled | BLOCKED by unproven #36/#37/#32. Keep current bwrap network isolation; do not treat source CI as runtime authorization. |
| #41 Figma auth | Vendor-source investigation above | FIGMA_HEADLESS_AUTH_NOT_PROVEN; no credentials or external writes. |

The pinned [Action settings implementation](https://github.com/anthropics/claude-code-action/blob/6fed3ca145920b639991cb756090506e1bcaf515/base-action/src/setup-claude-code-settings.ts)
unconditionally sets `enableAllProjectMcpServers=true` **after** input merge.
Its [launcher](https://github.com/anthropics/claude-code-action/blob/6fed3ca145920b639991cb756090506e1bcaf515/src/entrypoints/run.ts)
selects Claude Code **2.1.293**. A false setting in workflow JSON would not solve
startup authorization; PR #43 uses native exclusive MCP/setting-source flags.
Current CLI documentation is supporting evidence, not an executed pin-specific
startup proof.

Capability dependencies remain #36/#37/#32 runtime isolation → #40 controlled
research and trusted MCP capability resolution → #41 authorized read-only runner
pilot → separately approved draft write → independent visual transport/#22 actual
parity → legal-office capability pilot → separate platform and bmsl rollout.

Merge gates apply separately within every phase: source changes and the contract's
required premerge proof → final-HEAD independent review and hosted CI → owner R3
merge → exact-main CI → separately reviewed consumer R3 SHA pin → consumer runtime
proof before enabling the next dependent capability. Diagnostic rollout does not
waive a contract that requires actual-tool proof before implementation merge.
Source work on independent branches does not waive any gate.
Each PR needs independent review at its final HEAD and hosted exact-head CI;
local Windows parser adapters and source checks are not Linux runtime evidence.
No Issue is closed and no `autopilot:ready` label is granted to an R3 task.

## Phased implementation, independent R3 gates

### Phase 0 — this Issue / this PR

- Write source-grounded feasibility, capability and credential policy.
- Confirm current central SHA and distinguish existing evidence from unproven behavior.
- Design test matrix and follow-on Tasks. **No workflow change and no external side effect.**

### Phase 1 — close existing safety issues

- #36: negative proof that non-Bash Read cannot reach synthetic sensitive paths.
- #37: negative proof that a project-supplied MCP server never spawns without trusted allowlisting. Compare pinned vendor source to running Action.
- #32: network and canary isolation negative evidence. This is separate from allowing outbound traffic.
- Each task requires its own R3 exact-head review, owner merge and exact-main CI.

### Phase 2 — public research / build capabilities

- Implement a centrally pinned, reviewed, controlled-fetch mechanism and trusted provenance artifact first.
- Introduce a narrowly scoped egress proxy only if directly needed for sandboxed tasks, preserving command sandbox and no privilege inheritance.
- Positive: fetch approved harmless public doc and run locked dependency/test loop.
- Negative: blocked unapproved public domain, DNS/IP SSRF, redirect outside allowlist, private metadata endpoint, no credentials in tools/logs.

### Phase 3 — Figma read-only feasibility pilot

- On one explicitly approved disposable consumer/draft and with owner-authorized credentials, test official Figma Remote MCP connect, auth reuse on a **new ephemeral runner**, read tool discovery, expiry/re-auth behavior, policy isolation. Record run ID and provider evidence.
- If not supported, stop as NOT_PROVEN; do not add a nonfunctional figma MCP config that only works on a desktop login.

### Phase 4 — Figma draft write + code handoff

- Approve file and account scope independently. Test one small create/update via use_figma on a disposable copy, screenshot before/after, audit write and conflict/retry.
- Verify unauthorized different-file write is denied at the provider/policy boundary, not just by a prompt. If impossible, keep it manual.
- Update #22 visual Reviewer evidence. Run CI at exact PR HEAD and require R3 human merge for the shared workflow changes.

### Phase 5 — rollout per consumer

- Consumer chooses central immutable full SHA in its own R3 PR, explicitly passes narrowly scoped secrets (never secrets: inherit) and enables only trusted profiles.
- legal-office first; retain V4 fallback until end-to-end parity. platform and bmsl separately, no implicit org-wide listener.
- Success means **GitHub E2E evidence AND Figma provider-side effect evidence**. Merely seeing MCP configuration in YAML is not success.

## Test / evidence matrix

| Test | Expected proof | Current state |
|---|---|---|
| Existing central CI exact-HEAD | actionlint and contract tests at PR HEAD | Required for any change |
| Project-defined MCP marker startup | Untrusted project MCP does not spawn without authorization | #37 OPEN / NOT PROVEN |
| Non-Bash Read canary | Sensitive path denied without reading value | #36 OPEN / NOT PROVEN |
| Network isolation canary | Disallowed network path rejected | #32 OPEN / NOT PROVEN |
| Official vendor Figma auth | Session survives new ephemeral job by documented supported mechanism | NOT PROVEN |
| Figma readonly smoke | Approved file read, no unauthorized writes | NOT RUN |
| Figma write smoke | New/edit layer in approved draft with audit | NOT RUN |
| Wrong Figma target | Provider-enforced deny, unrelated file untouched | NOT RUN |
| Visual parity | Reviewer compares Figma and runtime screenshots at exact HEAD | #22 OPEN |
| GitHub publish / merge | Clean Publisher Draft PR; R3 remains human merge only | Existing pattern, no change |

## Exit criteria / owner gates

- A Phase 0 PR can merge only under R3 owner control with exact-HEAD CI and independent review, then exact-main CI. It **does not activate any capability**.
- Human authorization remains mandatory for Figma OAuth/account connection, new secrets, external writes, sensitive ACLs, production/customer data, changes to GitHub App or infrastructure and R3 merge.
- Do not report CONNECTED, SECURE, FIGMA-WRITE-READY or RUNTIME-PROVEN without real evidence from the appropriate environment.
- No automatic future execution has been scheduled by this document.
