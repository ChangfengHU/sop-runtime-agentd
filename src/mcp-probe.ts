import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { mcpConnectionSchema, mcpBindingDigest, mcpSchemaDigest, type McpConnection } from "./mcp-session.js";
import { checkInstalledMcpCredentialBinding } from "./mcp-credential-binding.js";
import { resolveMcpCredential } from "./mcp-credential.js";

export function validateMcpConnection(raw: unknown): McpConnection {
  const parsed = mcpConnectionSchema.safeParse(raw);
  if (!parsed.success) throw Error("mcp_connection_invalid");
  const binding = parsed.data, url = new URL(binding.url);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw Error("mcp_endpoint_not_allowed");
  if (Object.keys(binding.headers).some(name => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || ["host", "content-type", "accept", "mcp-session-id", "mcp-protocol-version", "cookie"].includes(name.toLowerCase()))) throw Error("mcp_header_not_allowed");
  if (Object.keys(binding.headers).length !== new Set(Object.keys(binding.headers).map(name => name.toLowerCase())).size) throw Error("mcp_header_not_allowed");
  return binding;
}

type ProbeOptions = {
  authorize?: (binding: McpConnection) => Promise<void>;
  resolveCredential?: typeof resolveMcpCredential;
  // Test transport only; never accepted in an HTTP request.
  fetch?: typeof fetch;
};

/** Read only protocol discovery. This client never invokes tools/call or starts a model. */
export async function probeMcpConnection(raw: unknown, signal: AbortSignal, options: ProbeOptions = {}) {
  const binding = validateMcpConnection(raw);
  await (options.authorize || checkInstalledMcpCredentialBinding)(binding);
  const secrets: string[] = [], headers: Record<string, string> = {};
  let transport: StreamableHTTPClientTransport | undefined;
  const client = new Client({ name: "sop-agentd-catalog", version: "1" });
  try {
    for (const [name, reference] of Object.entries(binding.headers)) {
      const secret = await (options.resolveCredential || resolveMcpCredential)(reference, signal);
      if (!secret || /[\r\n]/.test(secret)) throw Error("mcp_credential_unavailable");
      headers[name] = secret; secrets.push(secret);
      if (/^Bearer /i.test(secret)) secrets.push(secret.slice(7));
    }
    transport = new StreamableHTTPClientTransport(new URL(binding.url), {
      requestInit: { headers, redirect: "error" },
      ...(options.fetch ? { fetch: options.fetch } : {}),
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
    await client.connect(transport as Parameters<Client["connect"]>[0], { timeout: 15_000, signal });
    const tools: Array<Record<string, unknown>> = [], names = new Set<string>(), cursors = new Set<string>();
    const validator = new AjvJsonSchemaValidator();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await client.listTools(cursor ? { cursor } : {}, { timeout: 15_000, signal });
      for (const rawTool of result.tools) {
        if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(rawTool.name) || names.has(rawTool.name)) throw Error("mcp_invalid_tool_catalog");
        names.add(rawTool.name);
        const tool = { name: rawTool.name, ...(rawTool.description ? { description: rawTool.description.slice(0, 200) } : {}), inputSchema: rawTool.inputSchema, ...(rawTool.outputSchema ? { outputSchema: rawTool.outputSchema } : {}) };
        if (secrets.some(secret => JSON.stringify(tool).includes(secret))) throw Error("mcp_credential_exposed_in_schema");
        validator.getValidator(tool.inputSchema as Parameters<AjvJsonSchemaValidator["getValidator"]>[0]);
        tools.push({ ...tool, schema_digest: mcpSchemaDigest(tool) });
      }
      if (tools.length > 1000 || JSON.stringify(tools).length > 2_000_000) throw Error("mcp_tool_catalog_limit");
      if (!result.nextCursor) return { tools, binding_digest: mcpBindingDigest(binding) };
      if (cursors.has(result.nextCursor)) throw Error("mcp_invalid_tool_cursor");
      cursors.add(result.nextCursor); cursor = result.nextCursor;
    }
    throw Error("mcp_tool_catalog_limit");
  } catch (error) {
    if (error instanceof Error && /^mcp_[a-z_]+$/.test(error.message)) throw error;
    throw Error("mcp_catalog_probe_failed");
  } finally {
    await client.close().catch(() => {});
    await transport?.close().catch(() => {});
  }
}
