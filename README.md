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
