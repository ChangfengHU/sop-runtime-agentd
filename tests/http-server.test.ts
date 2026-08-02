import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AdapterRunContext, AgentCapabilities, AgentRuntimeAdapter } from "../src/contracts.js";
import { EventHub } from "../src/event-hub.js";
import { createHttpServer } from "../src/http-server.js";
import { ProviderRegistry } from "../src/providers.js";
import { SupervisorStore } from "../src/store.js";
import { RuntimeAgentSupervisor } from "../src/supervisor.js";

class HttpFakeAdapter implements AgentRuntimeAdapter {
  readonly id = "sop-native" as const;
  readonly displayName = "HTTP Fake";
  capabilities(): AgentCapabilities {
    return {
      persistentSessions: false,
      streamingEvents: true,
      toolEvents: false,
      approvals: false,
      steering: false,
      resume: false,
      subagents: false,
      nativeCancellation: true,
      skills: true,
      localWorkspace: true,
    };
  }
  async probe(): Promise<{ ok: boolean; detail: Record<string, unknown>; reason: string }> {
    return { ok: true, detail: {}, reason: "" };
  }
  async run(context: AdapterRunContext): Promise<{ sessionId: string; nativeRunId: string; responseText: string }> {
    await fs.writeFile(path.join(context.execution.outputDir, "result.json"), '{"ok":true}\n', "utf8");
    return { sessionId: "session-http", nativeRunId: "run-http", responseText: "ok" };
  }
}

test("serves execution records, replayable events, and artifact content", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sop-agentd-http-"));
  const workspace = path.join(root, "workspace");
  const providerDir = path.join(root, "providers");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(providerDir, { recursive: true });
  await fs.writeFile(
    path.join(providerDir, "test-provider.json"),
    JSON.stringify({
      id: "test-provider",
      protocol: "openai-compatible",
      provider: "test",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test-model",
      credentialRef: "env:TEST_PROVIDER_KEY",
    }),
  );
  const store = new SupervisorStore(path.join(root, "supervisor.db"));
  const supervisor = new RuntimeAgentSupervisor(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir: root,
      databasePath: path.join(root, "supervisor.db"),
      credentialDir: path.join(root, "credentials"),
      providerDir,
      maxConcurrent: 1,
      internalToken: "secret",
    },
    store,
    new EventHub(),
    new ProviderRegistry(providerDir),
    [new HttpFakeAdapter()],
  );
  const server = createHttpServer(supervisor);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: "Bearer secret" };
  try {
    const unauthorized = await fetch(`${base}/health`);
    assert.equal(unauthorized.status, 401);
    const response = await fetch(`${base}/v1/executions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        instanceId: "instance-http",
        engine: "sop-native",
        providerId: "test-provider",
        workspace,
        outputDir: path.join(workspace, "outputs"),
        instruction: "Run HTTP test",
      }),
    });
    assert.equal(response.status, 202);
    const submitted = (await response.json()) as { execution: { id: string } };
    let execution: { status: string; artifacts: Array<{ id: string }> } | undefined;
    for (let index = 0; index < 100; index += 1) {
      const current = await fetch(`${base}/v1/executions/${submitted.execution.id}`, { headers });
      execution = ((await current.json()) as { execution: typeof execution }).execution;
      if (execution?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(execution?.status, "completed");
    assert.equal(execution?.artifacts.length, 1);
    const events = await fetch(`${base}/v1/executions/${submitted.execution.id}/events`, { headers });
    const eventPayload = (await events.json()) as { events: Array<{ id: number; type: string }> };
    assert.equal(eventPayload.events.at(-1)?.type, "execution.completed");
    assert(eventPayload.events.every((event, index) => index === 0 || event.id > eventPayload.events[index - 1]!.id));
    const artifact = await fetch(
      `${base}/v1/executions/${submitted.execution.id}/artifacts/${execution?.artifacts[0]?.id}`,
      { headers },
    );
    assert.equal(artifact.headers.get("content-type"), "application/json");
    assert.deepEqual(await artifact.json(), { ok: true });
  } finally {
    server.close();
    await supervisor.close();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
