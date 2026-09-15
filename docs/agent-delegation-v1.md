# Single delegation runtime adapter

Pi exposes list_delegate_agents, delegate_agent, get_delegation and cancel_delegation only when the session has a delegation context and matching tool allowlist. Child sessions are excluded. Identity is taken from the execution, not model arguments. The control plane verifies its registered parent session, actual running execution and policy version.

The existing isolated IPC tool bridge makes HTTPS calls to the configured control-plane origin. No credentials or model-controlled endpoints are added. mergeTurnMetadata preserves delegation context and child binding. Health advertises singleDelegation so unsupported runtimes fail explicitly.

Long tasks return queued immediately; control-plane tracks progress and delivers the result as an idempotent parent turn, freeing the execution slot. Multi-step workflows remain in Mastra.

Verification: npm run build; node --import tsx --test tests/delegation-tools.test.ts tests/pi-tool-policy.test.ts tests/tool-allowlist.test.ts. Deployment goes through Harness operations Agents.
