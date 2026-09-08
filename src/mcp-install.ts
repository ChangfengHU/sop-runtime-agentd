import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { mcpBindingDigest, mcpConnectionSchema } from "./mcp-session.js";
import { validateMcpConnection } from "./mcp-probe.js";

/** Replace one machine's desired connection set atomically. Never reads or writes secret values. */
export async function installMcpConnections(raw: unknown, destination: string): Promise<{ installed: number; changed: boolean }> {
  const parsed = z.object({ connections: z.array(mcpConnectionSchema).max(1000) }).strict().safeParse(raw);
  if (!parsed.success) throw Error("mcp_install_manifest_invalid");
  const connections = parsed.data.connections.map(validateMcpConnection);
  if (new Set(connections.map(binding => binding.server_id)).size !== connections.length) throw Error("mcp_duplicate_server");
  const content = JSON.stringify({ bindings: connections.filter(binding => Object.keys(binding.headers).length).map(mcpBindingDigest).sort() }) + "\n";
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  let previous = "";
  try { previous = await fs.readFile(destination, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (previous === content) return { installed: connections.length, changed: false };
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const file = await fs.open(temporary, "wx", 0o644);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    await fs.rename(temporary, destination);
    const directory = await fs.open(path.dirname(destination), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.unlink(temporary).catch(() => {}); }
  return { installed: connections.length, changed: true };
}
