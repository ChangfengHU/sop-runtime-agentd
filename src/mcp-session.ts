import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const exactName = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.-]+$/);
export const mcpConnectionSchema = z.object({
  server_id: exactName,
  url: z.string().url(),
  headers: z.record(z.string(), z.string().regex(/^vault:[^\s]+$/)).default({}),
}).strict();
export type McpConnection = z.infer<typeof mcpConnectionSchema>;
export const mcpBindingSchema = mcpConnectionSchema.extend({
  tools: z.array(z.object({ name: exactName, schema_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict()).min(1).max(100),
}).strict();
export type McpBinding = z.infer<typeof mcpBindingSchema>;
export type McpModelTool = { id: string; name: string; description: string; inputSchema: Tool["inputSchema"]; schema_digest: string };

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
export function mcpSchemaDigest(tool: Pick<Tool, "inputSchema" | "outputSchema">): string {
  return `sha256:${createHash("sha256").update(canonical({ inputSchema: tool.inputSchema, outputSchema: tool.outputSchema ?? null })).digest("hex")}`;
}
export function mcpModelName(id: string): string {
  return `mcp_${createHash("sha256").update(id).digest("hex").slice(0, 40)}`;
}
export function mcpBindingDigest(binding: McpConnection): string {
  return `sha256:${createHash("sha256").update(canonical({ server_id: binding.server_id, url: binding.url, headers: binding.headers })).digest("hex")}`;
}

type Options = {
  resolveCredential(reference: string): Promise<string>;
  authorize(binding: McpBinding, tool: string): Promise<void>;
  signal: AbortSignal;
  // Used only by loopback fixtures; execution metadata cannot enable local HTTP.
  allowLocalHttp?: boolean;
};
type Connection = { binding: McpBinding; client: Client; transport: StreamableHTTPClientTransport; secrets: string[] };

/** Parent-process MCP proxy. Neither upstream URLs nor credentials are sent to the model worker. */
export class McpSession {
  readonly tools: McpModelTool[] = [];
  private readonly connections = new Map<string, Connection>();
  private readonly validators = new AjvJsonSchemaValidator();
  constructor(private readonly options: Options) {}

  async prepare(rawBindings: unknown, allowlist: string[]): Promise<void> {
    const parsed = z.array(mcpBindingSchema).max(20).safeParse(rawBindings);
    if (!parsed.success) throw Error("mcp_bindings_invalid");
    const bindings = parsed.data;
    const servers = new Set<string>();
    try {
      for (const binding of bindings) {
        if (servers.has(binding.server_id)) throw Error("mcp_duplicate_server");
        servers.add(binding.server_id);
        const selected = binding.tools.filter((tool) => allowlist.includes(`${binding.server_id}::${tool.name}`));
        if (!selected.length) continue;
        const url = new URL(binding.url);
        const local = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
        if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(this.options.allowLocalHttp && local && url.protocol === "http:"))) {
          throw Error("mcp_endpoint_not_allowed");
        }
        await this.options.authorize(binding, selected[0]!.name);
        const headers: Record<string, string> = {};
        const secrets: string[] = [];
        for (const [name, reference] of Object.entries(binding.headers)) {
          if (["host", "content-type", "accept", "mcp-session-id", "mcp-protocol-version", "cookie"].includes(name.toLowerCase())) throw Error("mcp_header_not_allowed");
          const secret = await this.options.resolveCredential(reference);
          if (!secret || /[\r\n]/.test(secret)) throw Error("mcp_credential_unavailable");
          headers[name] = secret;
          secrets.push(secret);
          if (/^Bearer /i.test(secret)) secrets.push(secret.slice(7));
        }
        const transport = new StreamableHTTPClientTransport(url, {
          requestInit: { headers, redirect: "error" },
          reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
        });
        const client = new Client({ name: "sop-agentd-session", version: "1" });
        const connection = { binding, transport, client, secrets };
        this.connections.set(binding.server_id, connection);
        // SDK 1.29 declares optional fields differently under exactOptionalPropertyTypes.
        await client.connect(transport as Parameters<Client["connect"]>[0], { timeout: 15_000, signal: this.options.signal });
        const advertised = await this.list(connection);
        const names = new Set<string>();
        for (const selectedTool of selected) {
          await this.options.authorize(binding, selectedTool.name);
          if (names.has(selectedTool.name)) throw Error("mcp_duplicate_tool");
          names.add(selectedTool.name);
          const tool = advertised.find((item) => item.name === selectedTool.name);
          if (!tool || mcpSchemaDigest(tool) !== selectedTool.schema_digest) throw Error("mcp_tool_schema_changed");
          if (secrets.some(secret => JSON.stringify(tool).includes(secret))) throw Error("mcp_credential_exposed_in_schema");
          this.validators.getValidator(tool.inputSchema as Parameters<AjvJsonSchemaValidator["getValidator"]>[0]); // Unsupported schemas fail before model dispatch.
          const id = `${binding.server_id}::${tool.name}`;
          this.tools.push({ id, name: mcpModelName(id), description: tool.description || id, inputSchema: tool.inputSchema, schema_digest: selectedTool.schema_digest });
        }
      }
      for (const id of allowlist.filter((name) => name.includes("::"))) {
        if (!this.tools.some((tool) => tool.id === id)) throw Error("mcp_selected_tool_unbound");
      }
    } catch (error) {
      await this.close();
      if (error instanceof Error && /^mcp_[a-z_]+$/.test(error.message)) throw error;
      throw Error("mcp_session_prepare_failed");
    }
  }

  private async list(connection: Connection): Promise<Tool[]> {
    const tools: Tool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await connection.client.listTools(cursor ? { cursor } : {}, { timeout: 15_000, signal: this.options.signal });
      tools.push(...result.tools);
      if (tools.length > 1000 || new Set(tools.map((tool) => tool.name)).size !== tools.length) throw Error("mcp_invalid_tool_catalog");
      if (!result.nextCursor) return tools;
      if (cursors.has(result.nextCursor)) throw Error("mcp_invalid_tool_cursor");
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw Error("mcp_tool_catalog_limit");
  }

  async call(id: string, args: unknown): Promise<unknown> {
    const selected = this.tools.find((tool) => tool.id === id);
    if (!selected) throw Error("mcp_tool_not_allowed");
    const serverId = id.split("::")[0]!;
    const connection = this.connections.get(serverId);
    if (!connection) throw Error("mcp_session_closed");
    const toolName = id.slice(serverId.length + 2);
    try {
      await this.options.authorize(connection.binding, toolName);
      const current = (await this.list(connection)).find((tool) => tool.name === toolName);
      if (!current || mcpSchemaDigest(current) !== selected.schema_digest) throw Error("mcp_tool_schema_changed");
      if (!this.validators.getValidator(selected.inputSchema as Parameters<AjvJsonSchemaValidator["getValidator"]>[0])(args).valid) throw Error("mcp_tool_arguments_invalid");
      // Never retry tools/call: an interrupted reply is not proof that no side effect occurred.
      const result = await connection.client.callTool({ name: toolName, arguments: args as Record<string, unknown> }, undefined, { timeout: 60_000, signal: this.options.signal });
      if (result.isError) throw Error("mcp_tool_reported_error");
      let text = JSON.stringify(result);
      if (text.length > 2_000_000) throw Error("mcp_result_too_large");
      for (const secret of connection.secrets) text = text.split(secret).join("[REDACTED]");
      return JSON.parse(text);
    } catch (error) {
      if (error instanceof Error && /^mcp_[a-z_]+$/.test(error.message)) throw error;
      throw Error("mcp_tool_call_failed");
    }
  }

  async close(): Promise<void> {
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.allSettled(connections.map(async ({ client, transport }) => {
      // Local close aborts outstanding requests; it never replays tool calls.
      await client.close();
      await transport.close();
    }));
  }
}
