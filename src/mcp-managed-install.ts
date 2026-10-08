import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { validateMcpConnection } from "./mcp-probe.js";
import { mcpConnectionSchema, mcpBindingDigest } from "./mcp-session.js";

const contextSchema = z.object({
  agent_id: z.string().min(1).max(200), agent_version: z.number().int().positive(),
  runtime_id: z.string().min(1).max(200), capability_binding_id: z.string().min(1).max(200),
  tool_name: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/), schema_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();
const manifestSchema = z.object({ connection: mcpConnectionSchema, context: contextSchema }).strict();
const installedSchema = z.object({ bindings: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)).max(1000) }).strict();
const locks = new Map<string, Promise<void>>();

/** Install exactly the frozen Fleet connection authorized for this preparing session. */
export async function installManagedMcpConnection(raw: unknown, signal: AbortSignal, options: { destination?: string; fetch?: typeof fetch; controlOrigin?: string } = {}) {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw Error("mcp_managed_install_invalid");
  const connection = validateMcpConnection(parsed.data.connection), context = parsed.data.context;
  const digest = mcpBindingDigest(connection), origin = options.controlOrigin || process.env.SOP_MCP_CONTROL_URL || "https://control.vyibc.com";
  if (new URL(origin).protocol !== "https:") throw Error("mcp_control_endpoint_invalid");
  const url = new URL(`/api/agent-presets/${encodeURIComponent(context.agent_id)}/mcp-access`, origin);
  url.search = new URLSearchParams({ runtime_id: context.runtime_id, version: String(context.agent_version), capability_binding_id: context.capability_binding_id, server_id: connection.server_id, tool_name: context.tool_name, schema_digest: context.schema_digest, binding_digest: digest }).toString();
  let response: Response;
  try { response = await (options.fetch || fetch)(url, { redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) }); }
  catch { throw Error("mcp_environment_check_unavailable"); }
  const grant = await response.json().catch(() => ({})) as { ok?: boolean; allowed?: boolean; capability_binding_id?: string; agent_version?: number };
  if (!response.ok || !grant.ok || !grant.allowed || grant.capability_binding_id !== context.capability_binding_id || grant.agent_version !== context.agent_version) throw Error("mcp_environment_denied");
  const file = options.destination || process.env.SOP_MCP_CREDENTIAL_BINDINGS_FILE || "/etc/sop-runtime-agentd/mcp-credentials.json";
  const previousLock = locks.get(file) || Promise.resolve();
  let unlock!: () => void;
  const lock = new Promise<void>(resolve => { unlock = resolve; });
  locks.set(file, lock);
  await previousLock;
  try {
    let bindings: string[] = [];
    try { bindings = installedSchema.parse(JSON.parse(await fs.readFile(file, "utf8"))).bindings; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw Error("mcp_credential_binding_unavailable"); }
    if (bindings.includes(digest)) return { binding_digest: digest, installed: true, changed: false };
    if (bindings.length >= 1000) throw Error("mcp_credential_binding_limit");
    const content = JSON.stringify({ bindings: [...new Set([...bindings, digest])].sort() }) + "\n";
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, "wx", 0o644);
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, file);
    } finally { await fs.unlink(temporary).catch(() => {}); }
    return { binding_digest: digest, installed: true, changed: true };
  } finally { unlock(); if (locks.get(file) === lock) locks.delete(file); }
}
