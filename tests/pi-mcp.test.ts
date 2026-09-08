import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PiAdapter } from "../src/adapters/pi-adapter.js";
import { CredentialResolver } from "../src/credentials.js";
import { EventHub } from "../src/event-hub.js";
import { ProviderRegistry } from "../src/providers.js";
import { SupervisorStore } from "../src/store.js";
import { RuntimeAgentSupervisor } from "../src/supervisor.js";
import { mcpModelName } from "../src/mcp-session.js";
import { fixture } from "./mcp-session.fixture.js";

test("real supervisor / pi adapter / worker completes one selected MCP call without exposing connection credentials", async () => {
  const mcp = await fixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mcp-integration-"));
  const providerDir = path.join(root, "providers");
  await fs.mkdir(providerDir);
  const requests: Array<{ tools: Array<{ function: { name: string } }>; messages: unknown[] }> = [];
  const model = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += String(chunk);
    requests.push(JSON.parse(text));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const first = requests.length === 1;
    const delta = first
      ? { role: "assistant", tool_calls: [{ index: 0, id: "call-one", type: "function", function: { name: mcpModelName("records::lookup"), arguments: '{"key":"one"}' } }] }
      : { role: "assistant", content: "Looked up one record" };
    for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: first ? "tool_calls" : "stop" }]) {
      response.write(`data: ${JSON.stringify({ id: "local-reply", object: "chat.completion.chunk", created: 1, model: "local-test", choices: [{ index: 0, ...choice }] })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  const address = model.address(); assert.ok(address && typeof address !== "string");
  await fs.writeFile(path.join(providerDir, "local.json"), JSON.stringify({ id: "local", protocol: "openai-compatible", provider: "local-test", model: "local-test", baseUrl: `http://127.0.0.1:${address.port}/v1`, credentialRef: "env:LOCAL_MODEL_FIXTURE" }));
  const providers = new ProviderRegistry(providerDir);
  const store = new SupervisorStore(path.join(root, "supervisor.db"));
  const adapter = new PiAdapter({
    dataDir: root, providers,
    credentialResolver: new CredentialResolver(root, { LOCAL_MODEL_FIXTURE: "local-model-test-only" }),
    mcpFactory: async execution => { await mcp.proxy.prepare(execution.metadata.mcp_bindings, execution.metadata.tool_allowlist as string[]); return mcp.proxy; },
  });
  const supervisor = new RuntimeAgentSupervisor({ host: "127.0.0.1", port: 0, dataDir: root, databasePath: path.join(root, "supervisor.db"), credentialDir: root, providerDir, maxConcurrent: 1, internalToken: "" }, store, new EventHub(), providers, [adapter]);
  try {
    const { session, execution } = await supervisor.createSession({
      instanceId: "local-instance", engine: "sop-native", providerId: "local", workspace: root,
      metadata: { preset_id: "reader", tool_allowlist: ["records::lookup"], mcp_bindings: [mcp.binding], agent_access_snapshot: { agent_id: "reader", agent_version: 1, runtime_id: "ordinary-fixture" } },
      firstInstruction: "Use the lookup tool once and summarize",
    });
    assert.ok(execution);
    const done = await supervisor.waitForTerminal(execution.id, 25_000);
    assert.equal(done.execution.status, "completed", done.execution.error);
    assert.equal(requests.length, 2);
    assert.equal(mcp.calls.length, 1);
    for (const request of requests) assert.deepEqual(request.tools.map(tool => tool.function.name), [mcpModelName("records::lookup")]);
    const serialized = JSON.stringify({ requests, session: supervisor.getSession(session.id), execution: done.execution, events: supervisor.listEvents(execution.id) });
    assert.ok(!serialized.includes("private-fixture-token"));
    assert.ok(JSON.stringify(requests[1]?.messages).includes("[REDACTED]"));
    const events = supervisor.listEvents(execution.id);
    assert.ok(events.some(event => event.type === "mcp.binding.applied"));
    assert.ok(events.some(event => event.type === "tool.execution.completed"));
    const applied = events.find(event => event.type === "tools.allowlist.applied")?.data as { allowed?: unknown } | undefined;
    assert.deepEqual(applied?.allowed, ["records::lookup"]);
  } finally {
    await supervisor.close(); store.close(); await mcp.close();
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
