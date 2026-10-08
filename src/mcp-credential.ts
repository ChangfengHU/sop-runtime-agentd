import fs from "node:fs/promises";

/** Existing Fleet service records retain their token field; no duplicate secret is stored. */
export function mcpCredentialValue(value: unknown, field?: string): string {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  let selected = field && record ? record[field] : value;
  if (selected === undefined && field === "authorization" && record) {
    const token = record.MCP_TOKEN ?? record.token;
    if (typeof token === "string" && token && !/[\r\n]/.test(token)) selected = /^Bearer /i.test(token) ? token : `Bearer ${token}`;
  }
  if (typeof selected !== "string" || !selected || /[\r\n]/.test(selected)) throw Error("mcp_credential_value_invalid");
  return selected;
}

export async function resolveMcpCredential(reference: string, signal: AbortSignal): Promise<string> {
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
  return mcpCredentialValue(record.value, match[2]);
}
