# Codex execution user / connection-test acceptance — 2026-10-04

Target: `runtime-129-213-30-236`; supervisor 0.6.4. Source bootstrap updated on `runtime-fleet-ops-188` without restarting its services.

## Confirmed cause

The failed historical session `session-9a3157fe-7592-403f-9107-bcfe7b1e4853` belongs to instance `codex-test`, with its former workspace `/root/wiki/codex-test`. Codex was installed, but the resident engine ran as root. Root was not logged in; claude was logged in through ChatGPT. The native turn ultimately returned `401 Unauthorized: Missing bearer or basic authentication in header`. Harness prematurely failed the execution at the recoverable `Reconnecting... 2/5` notification.

The old bootstrap also created `/home/claude/harness` as root:root 0755 while assigning its standard-instance children to claude. This prevented claude from creating additional instance directories. The standard installation helper now prepares the parent as claude:claude 0750; existing project contents and authentication files are untouched.

## Delivered behavior

- SQLite-backed per-instance `{user, workspace}` configuration, default Codex user claude. Supervisor service identity is independent and can stay root for protected Pi provider credentials.
- Codex processes run with the selected user's HOME and sanitized environment; no cross-user Codex home or OpenAI credentials are inherited.
- Session creation and subsequent turns use server configuration. Caller metadata cannot override execution identity/context. User/directory changes reset the native context, including switching back, while preserving the ledger.
- Connection tests validate CLI login and perform an isolated, read-only real model round trip. They require `HARNESS_CONNECTION_OK`, have a 60-second model deadline and close their processes. Candidate tests do not save configuration or modify an existing chat session.
- Recoverable errors stay running; final 401/interruption/process exit is a failure. Cancellation settles waiting turns.

## Verification

Full agentd suite: 54 passed (`npm test`); build/typecheck passed. After context/probe refinements, session + Codex regressions: 14 passed; final Codex regressions: 7 passed. Installer ref regression: 1 passed; both installation shell scripts pass `bash -n`.

Live negative: root login test fails with an explicit user-specific login message and HOME=/root. Live positive: claude model tests return `HARNESS_CONNECTION_OK` in approximately 5–6 seconds, HOME=/home/claude. Actual engine launcher/binary processes are owned by claude; the root sudo wrapper is infrastructure, not the engine identity.

Historical session repaired turn: `agent-execution-2c882644-1dd9-45b9-938e-617a762bf87d`, status completed, user claude, workspace `/home/claude/harness/codex-test`, reply `你好，连接正常`.

Standard page-instance chat: session `session-ca7cfee2-0de1-4725-b9f0-c6b1ae2882f2`, execution `agent-execution-83b6a2fe-f6f1-42f7-93f3-b8b930accfea`, completed with `HARNESS_CHAT_OK`, workspace `/home/claude/harness/codex`. Explicit caller metadata requesting root was ignored.

Agentd runtime checkout: `67ed9faae23fc33a9c7219645cd98e5af410b7b2` (code 586e806 plus installation-parent fix). Bridge runtime checkout: `9ca89122f8ae2639fad0c595978a3d602fef2af3`.

Scope: live changes verified on 236. Other existing runtimes were not upgraded; their connection-test route requires the corresponding supervisor/bridge version. Future installation uses the updated source bootstrap and main installation templates. This acceptance did not perform a fresh installation/removal cycle.
