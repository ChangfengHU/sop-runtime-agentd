import { resolveMcpCredential } from "./mcp-credential.js";
import { checkInstalledMcpCredentialBinding } from "./mcp-credential-binding.js";
import type { ExecutionRecord } from "./contracts.js";
import { McpSession, mcpBindingDigest, type McpBinding } from "./mcp-session.js";


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
    resolveCredential: (reference) => resolveMcpCredential(reference, signal),
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
