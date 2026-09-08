import fs from "node:fs/promises";
import { checkInstalledMcpCredentialBinding } from "./mcp-credential-binding.js";
import type { ExecutionRecord } from "./contracts.js";
import { McpSession, mcpBindingDigest, type McpBinding } from "./mcp-session.js";

async function credential(reference: string, signal: AbortSignal): Promise<string> {
  const match = /^vault:([^#]+)(?:#([a-zA-Z0-9_.-]+))?$/.exec(reference);
  if (!match) throw Error("mcp_credential_reference_invalid");
  // This is an infrastructure credential on the source host, never a human administrator account.
  const tokenFile = process.env.SOP_MCP_VAULT_TOKEN_FILE || "/etc/sop-runtime-agentd/credentials/fleet-vault.key";
  let token: string;
  try { token = (await fs.readFile(tokenFile, "utf8")).trim(); } catch { throw Error("mcp_credential_unavailable"); }
  if (!token) throw Error("mcp_credential_unavailable");
  const url = process.env.SOP_MCP_VAULT_URL || "https://fleet.vyibc.com/mcp/vault";
  if (new URL(url).protocol !== "https:") throw Error("mcp_credential_endpoint_invalid");
  const response = await fetch(url, {
    method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "vyibc-vault_get_config", arguments: { key: match[1] } } }),
  });
  if (!response.ok) throw Error("mcp_credential_unavailable");
  const data = await response.json() as { error?: unknown; result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> } };
  if (data.error || data.result?.isError) throw Error("mcp_credential_unavailable");
  const text = data.result?.content?.find((item) => item.type === "text")?.text;
  if (!text) throw Error("mcp_credential_unavailable");
  const record = JSON.parse(text) as { ok?: boolean; value?: unknown };
  if (!record.ok) throw Error("mcp_credential_unavailable");
  const value = match[2] && record.value && typeof record.value === "object"
    ? (record.value as Record<string, unknown>)[match[2]] : record.value;
  if (typeof value !== "string" || !value) throw Error("mcp_credential_value_invalid");
  return value;
}

export async function prepareExecutionMcp(execution: Pick<ExecutionRecord, "metadata">, signal: AbortSignal): Promise<McpSession | undefined> {
  const bindings = execution.metadata.mcp_bindings;
  const allowlist = execution.metadata.tool_allowlist as string[] | undefined;
  if ((!Array.isArray(bindings) || !bindings.length) && !allowlist?.some((name) => name.includes("::"))) return undefined;
  const snapshot = execution.metadata.agent_access_snapshot as Record<string, unknown> | undefined;
  if (!snapshot || typeof snapshot.agent_id !== "string" || typeof snapshot.runtime_id !== "string" || !Number.isInteger(snapshot.agent_version)) {
    throw Error("mcp_agent_snapshot_required");
  }
  const origin = process.env.SOP_MCP_CONTROL_URL || "https://control.vyibc.com";
  if (new URL(origin).protocol !== "https:") throw Error("mcp_control_endpoint_invalid");
  const session = new McpSession({
    signal,
    resolveCredential: (reference) => credential(reference, signal),
    authorize: async (binding: McpBinding, name: string) => {
      await checkInstalledMcpCredentialBinding(binding);
      const tool = binding.tools.find((item) => item.name === name);
      const url = new URL(`/api/agent-presets/${encodeURIComponent(String(snapshot.agent_id))}/mcp-access`, origin);
      url.search = new URLSearchParams({ runtime_id: String(snapshot.runtime_id), version: String(snapshot.agent_version), server_id: binding.server_id, tool_name: name, schema_digest: tool?.schema_digest || "", binding_digest: mcpBindingDigest(binding) }).toString();
      let response: Response;
      try { response = await fetch(url, { redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) }); }
      catch { throw Error("mcp_environment_check_unavailable"); }
      if (!response.ok) throw Error("mcp_environment_denied");
      const result = await response.json() as { ok?: boolean; allowed?: boolean };
      if (!result.ok || !result.allowed) throw Error("mcp_environment_denied");
    },
  });
  await session.prepare(bindings, allowlist || []);
  return session;
}
