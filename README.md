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
