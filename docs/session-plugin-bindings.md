# Session plugin binding (development, not deployed)

`POST /v1/sessions/:sessionId/plugin-bindings` accepts the checked-in
`tests/fixtures/plugin-binding-request.json` shape. The internal token is mandatory;
this endpoint is for the control plane, which must construct the request from its
plugin and MCP catalogs. Browser input must never supply repository paths, schema
locks, credential references, or Agent authorization snapshots directly.

`GET /v1/sessions/:sessionId/plugin-bindings/:pluginId` returns `{binding}` or 404.
A binding contains `sessionId`, `pluginId`, `commit`, `status` (`ready` or
`not_ready`), `runtimeId`, discovered skill `commands`, and named `checks` (`passed` / `failed`, with detail). Failed candidate
attempts retain the existing active binding and ordinary conversation. Successful
swaps replace it only after the candidate thread and skills have been verified.
Identical active requests revalidate skills and MCP authorization/schema without
starting a replacement thread. Runtime restarts/process exits invalidate readiness;
a stored ready record alone never grants access. `/health` advertises
`adapters[].capabilities.pluginBindings` for the Codex adapter.

## Package and isolation

Only explicit HTTPS GitHub URLs with a full 40-character commit are accepted. Git
uses no user/system config, terminal credential prompts or hooks. The entire
repository tree is fetched and verified, including reference files and assets;
symlinks, submodules, more than 20,000 files, and trees above 100 MB are refused.
`plugin.root` is repository-relative; each declared skill path is plugin-relative.
The native `.codex-plugin/plugin.json` must have the requested plugin name.

Every active binding has a dedicated app-server process and private CODEX_HOME.
Only the machine's existing Codex authentication is copied, with mode 0600; MCP
credentials never enter that process, environment or tool definitions. Machine
MCP configuration is not copied. A native MCP status listing must be empty.
`skills/extraRoots/set` is process-global, so it is used only in that dedicated
process. `skills/list` must discover each exact installed SKILL.md enabled.
Leading `/skill-name` commands are converted into an explicit Codex `skill` input only when the name and installed path were verified in this binding. Unknown commands are not rewritten.
No native plugin-install API is used: its global discovery/MCP behavior would
bypass the selected catalog-bound tool proxy.

MCP tools use experimental `thread/start.dynamicTools` and `item/tool/call`, backed
by the existing parent-process McpSession. Installed destination digests are checked
before resolving Vault references. Source policy and schema digests are checked at
preparation and every call. Cross-thread calls and unselected tools are refused;
responses redact resolved credentials. Preparation never invokes business tools.
`ready` means package/discovery/thread/tool binding checks passed, not that a real
render or business MCP call was executed.

## Existing conversation and permissions

Busy sessions reject mutations. Existing idle conversations require
`allowContinuation: true`: agentd keeps the same session identity but starts a new
native thread. All platform-visible instructions/responses, in ascending creation
order, are passed as an explicitly untrusted transcript on the first subsequent
user turn. Hidden reasoning, native tool history and native goals are not migrated.
History above 1,000 turns / 500 KB or incomplete history is refused without
truncation. Original native resume failures are not allowed to fall back to a fresh
thread while claiming to have retained its settings.

The source thread's model, reasoning effort and workspace-write sandbox/network
configuration are captured and compared against the candidate's actual response.
Other sandbox modes, custom providers, and custom `openai` provider overrides are
currently refused. Shell escalation is declined. Binding does not expand sandbox
or network permissions and does not establish that video download, npm installation,
voice services, or rendering are permitted or functional.

## Evidence and limitations

Protocol reference: OpenAI Codex 0.153.4 commit
`3d2ee51ca2d5db578f328aa75e20aa22c0197c9a` (Apache-2.0; reference only, no upstream
code copied). Local 0.154.0 generated experimental TypeScript schemas confirm
DynamicToolSpec, SkillsExtraRootsSetParams and response shapes. `thread/resume` and
`thread/fork` do not accept dynamicTools, hence explicit continuation.
Upstream: https://github.com/openai/codex/tree/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server

The local real CLI 0.154.0 non-model probe successfully initialized a dedicated
app-server, applied extra skill roots, started a thread, discovered the exact skill
and verified an empty native MCP catalog. No paid model call was made by that probe. A second real CLI probe captured the source thread model/reasoning/sandbox settings and successfully verified the dedicated replacement retained them (`gpt-6-astra`, null reasoning override, network disabled). New empty threads have no persisted rollout yet; their actual thread/start response is cached instead of falsely requiring thread/resume.
The HTTP integration test uses the real supervisor, Git objects, child JSON-RPC
transport, MCP SDK/HTTP fixture, Vault resolver and installed credential-destination
checks; only Codex model behavior and remote endpoint transport are fixtures. It
covers a two-turn continuation, model/sandbox retention, idempotency, failed upgrade
preservation, real selected tool calls, redaction and subsequent schema drift.
Production installation/authentication/rendering and live upstream services remain
unverified. This feature is not deployed.
