# SOP Runtime Agent Supervisor

`sop-runtime-agentd` is the runtime-local control plane for agent sessions and
Node executions. It sits behind the existing Runtime Bridge and normalizes
native agent engines into one execution, event, approval, cancellation, Skill,
and Artifact contract.

```text
A2A RPC -> Runtime Bridge -> sop-runtime-agentd -> Agent Adapter -> Skill outputs
```

DeepSeek, Qwen, and other API services are model providers. They are not
registered as agent engines. The first generic engine is `sop-native`, backed by
Pi Coding Agent and an Instance-scoped Agent Skills directory.

## Local development

```bash
npm install
npm run typecheck
npm test
npm run build
SOP_AGENTD_DATA_DIR="$PWD/.runtime" npm start
```

The service listens on `127.0.0.1:8789` by default. Runtime deployments should
use the provided systemd unit and keep the endpoint private to the Runtime.

## Runtime boundary

- `sop-native` is the first engine adapter and uses Pi Coding Agent.
- DeepSeek, Qwen, and similar APIs are Provider Profiles, not Agent engines.
- Codex App Server, Claude Agent SDK, Hermes Gateway, and OpenClaw Gateway remain separate adapter slots.
- A bound Skill and every file material must stay inside the selected Instance workspace.
- A successful bound-Skill execution must produce `manifest.json` and at least one business Artifact.

## Session tool policy

Supervisor `0.5.1` validates tool restrictions before session creation and direct
execution submission, and rechecks persisted session policies on every turn.

- `metadata.tool_allowlist` must be a non-empty list of exact tool names. Empty
  lists, malformed values, and wildcards return HTTP 403. Agent-bound requests
  (`preset_id`, `ops_agent_id`, or `agent_access_snapshot`) must include a list.
- Turn tools intersect the session list. A turn cannot relax a session's
  read-only scope or replace its Agent identity/access snapshot. The execution's
  `tool_allowlist` records the effective turn list; the snapshot remains the
  original session evidence.
- Only `sop-native` currently enforces this policy. Other engines reject an
  explicit tool list or read-only scope with `engine_tool_policy_not_supported`.
  Unrestricted legacy requests without Agent bindings retain their old behavior.
- Pi exposes the intersection with installed tools and emits
  `tools.allowlist.applied` for every declared policy. An empty effective list
  fails with `no_allowed_tools_available` before calling the model.

Read-only filtering removes the built-in `bash`, `edit`, and `write` tools. It
does not sandbox files, network access, or extension side effects. This is not
global authorization: upstream authentication, grant revocation, native-session
ownership checks, and all-engine isolation still require separate enforcement.

Local verification: `npm test` exercises HTTP rejection, persisted sessions,
turn narrowing, and the real Pi worker against a loopback model fixture (no
external model or production machine). `npm run build` compiles the service and
tests. Code verification does not mean a Runtime has been upgraded.

## MCP session tools

Supervisor `0.6.0` advertises `mcpTools: true` for `sop-native`. The control plane
provides `metadata.mcp_bindings` containing registered server IDs, HTTPS URLs,
Vault header references and selected tool names with `schema_digest` locks.
The matching `agent_access_snapshot` and canonical `server_id::tool_name`
allowlist are required. An ordinary turn cannot replace the session bindings.

The pi adapter connects to Streamable HTTP MCP servers in its parent process
using pinned MCP SDK `1.29.0`. It handles JSON/SSE responses and paginated tool
catalogs. The model worker receives selected tool schemas and stable hashed
model names, then calls the parent over IPC. Only the parent resolves headers
and sends requests; known authentication values are redacted from returned
content. Tool schemas are checked before loading and before each invocation;
new or changed tools do not automatically gain permission. Interrupted tool
calls are not replayed automatically.

Each load/call checks the current Agent version, registered source/ordinary
environment, selected tool and server configuration through the control plane's
`GET /api/agent-presets/:id/mcp-access`. This uses Runtime registration, not
human administrator accounts. `SOP_MCP_CONTROL_URL` optionally overrides the
trusted control service (default `https://control.vyibc.com`). Old control
services without that endpoint reject MCP dispatch instead of skipping checks.

Credential references use `vault:<key>` for a complete header string, or
`vault:<key>#<field>` for a top-level string field (for example
`vault:service:example#authorization`). No Bearer prefix is guessed or added.
The source host's private Vault credential file defaults to
`/etc/sop-runtime-agentd/credentials/fleet-vault.key`; optional overrides are
`SOP_MCP_VAULT_TOKEN_FILE` and `SOP_MCP_VAULT_URL`. Hosts without the required
credential reject authenticated MCP bindings. Upstream credentials are never
added to session/Execution metadata, worker IPC inputs or tool events.

This covers Streamable HTTP, not legacy SSE endpoints, stdio subprocesses,
OAuth login or OS-level sandboxing. Existing file/shell tools and source
extensions still require separate filesystem/network isolation. Old Runtime
versions must not receive MCP sessions until they advertise `mcpTools`.

Validation includes a real supervisor + pi adapter + isolated worker, with
loopback model/MCP fixtures, and rejection tests for schema drift, empty or
unbound selections, invalid arguments, environment changes, failed tools and
interrupted replies. These local fixtures do not establish production rollout
or a successful 63-machine workflow.

## Provider Profile

Create `/etc/sop-runtime-agentd/providers/deepseek-default.json`:

```json
{
  "id": "deepseek-default",
  "protocol": "openai-compatible",
  "provider": "deepseek",
  "baseUrl": "https://api.deepseek.com",
  "model": "deepseek-chat",
  "credentialRef": "file:deepseek-default.json",
  "options": {
    "thinking": "low",
    "maxTokens": 8192
  }
}
```

The matching credential belongs in
`/etc/sop-runtime-agentd/credentials/deepseek-default.json` with mode `0600`:

```json
{"apiKey":"configured-by-runtime-management"}
```

Neither the credential reference nor the secret value is returned by the
Provider listing API.

## HTTP API

- `GET /health`
- `GET /v1/adapters`
- `POST /v1/adapters/probe`
- `GET /v1/providers`
- `POST /v1/executions`
- `GET /v1/executions/{id}`
- `POST /v1/executions/{id}/cancel`
- `GET /v1/executions/{id}/events` (JSON or SSE)
- `GET /v1/executions/{id}/artifacts/{artifactId}`

Execution requests keep the public Node input stable as `instruction +
materials`. Skill-specific values are inferred by the bound Agent and Skill;
they do not become public Node API fields.
