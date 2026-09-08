import fs from "node:fs/promises";
import { z } from "zod";
import { mcpBindingDigest, type McpConnection } from "./mcp-session.js";

const installedSchema = z.object({
  bindings: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)).max(1000),
}).strict();

/** Installed machine dependencies pin credential destinations independently of editable catalogs. */
export async function checkInstalledMcpCredentialBinding(
  binding: McpConnection,
  file = process.env.SOP_MCP_CREDENTIAL_BINDINGS_FILE || "/etc/sop-runtime-agentd/mcp-credentials.json",
): Promise<void> {
  if (!Object.keys(binding.headers).length) return;
  let installed: z.infer<typeof installedSchema>;
  try {
    const source = await fs.readFile(file, "utf8");
    if (source.length > 100_000) throw Error();
    installed = installedSchema.parse(JSON.parse(source));
  } catch { throw Error("mcp_credential_binding_unavailable"); }
  if (!installed.bindings.includes(mcpBindingDigest(binding))) throw Error("mcp_credential_binding_not_installed");
}
