import assert from "node:assert/strict";
import { createServer } from "node:http";
import { McpSession, mcpSchemaDigest } from "../src/mcp-session.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export async function fixture(sse = false) {
  const secret = "Bearer private-fixture-token";
  let tools: Tool[] = [
    { name: "lookup", description: "Look up a record", inputSchema: { type: "object" as const, properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false } },
    { name: "delete", description: "Not selected", inputSchema: { type: "object" as const, properties: {}, required: [], additionalProperties: false } },
  ];
  const calls: unknown[] = [];
  const requests: Array<{ method: string; id?: number }> = [];
  let revoked = false, callError = false, disconnect = false;
  const server = createServer(async (request, response) => {
    if (request.method === "GET") { response.writeHead(405).end(); return; }
    assert.equal(request.headers.authorization, secret);
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const message = JSON.parse(body);
    requests.push(message);
    if (message.method === "notifications/initialized") { assert.equal(message.id, undefined); response.writeHead(202).end(); return; }
    let result: unknown;
    if (message.method === "initialize") {
      result = { protocolVersion: message.params.protocolVersion, serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {} } };
    } else {
      assert.equal(request.headers["mcp-session-id"], "fixture-session");
      assert.ok(request.headers["mcp-protocol-version"]);
      if (message.method === "tools/list") result = message.params.cursor ? { tools: tools.slice(1) } : { tools: tools.slice(0, 1), nextCursor: "page-two" };
      else {
        assert.equal(message.method, "tools/call"); calls.push(message.params);
        if (disconnect) { request.socket.destroy(); return; }
        result = { content: [{ type: "text", text: `result ${secret}` }], isError: callError };
      }
    }
    const reply = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
    response.writeHead(200, { "content-type": sse ? "text/event-stream" : "application/json", "mcp-session-id": "fixture-session" });
    response.end(sse ? `event: message\ndata: ${reply}\n\n` : reply);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const binding = { server_id: "records", url: `http://127.0.0.1:${address.port}/mcp`, headers: { authorization: "vault:mcp-records" }, tools: [{ name: "lookup", schema_digest: mcpSchemaDigest(tools[0]!) }] };
  const proxy = new McpSession({
    signal: new AbortController().signal, allowLocalHttp: true,
    resolveCredential: async reference => { assert.equal(reference, "vault:mcp-records"); return secret; },
    authorize: async () => { if (revoked) throw Error("mcp_environment_denied"); },
  });
  return { proxy, binding, calls, requests, secret,
    revoke: () => { revoked = true; }, failTool: () => { callError = true; }, disconnect: () => { disconnect = true; },
    changeSchema: () => { tools = tools.map(tool => tool.name === "lookup" ? { ...tool, inputSchema: { ...tool.inputSchema, required: ["key", "extra"] } } : tool); },
    close: async () => { await proxy.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
