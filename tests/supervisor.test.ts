import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  AdapterRunContext,
  AdapterRunResult,
  AgentCapabilities,
  AgentRuntimeAdapter,
} from "../src/contracts.js";
import { EventHub } from "../src/event-hub.js";
import { ProviderRegistry } from "../src/providers.js";
import { SupervisorStore } from "../src/store.js";
import { RuntimeAgentSupervisor } from "../src/supervisor.js";

class FakeAdapter implements AgentRuntimeAdapter {
  readonly id = "sop-native" as const;
  readonly displayName = "Fake Agent";

  capabilities(): AgentCapabilities {
    return {
      persistentSessions: false,
      streamingEvents: true,
      toolEvents: true,
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

  async run(context: AdapterRunContext): Promise<AdapterRunResult> {
    await context.emit({
      type: "tool.execution.started",
      status: "running",
      producer: "fake",
      subject: { kind: "tool", id: "write-output" },
      summary: "Writing output",
      data: {},
    });
    await fs.writeFile(path.join(context.execution.outputDir, "article.md"), "# Real artifact\n", "utf8");
    await fs.writeFile(path.join(context.execution.outputDir, "manifest.json"), "{}\n", "utf8");
    return { sessionId: "fake-session", nativeRunId: "fake-run", responseText: "done" };
  }
}

async function fixture(): Promise<{
  root: string;
  workspace: string;
  supervisor: RuntimeAgentSupervisor;
  store: SupervisorStore;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sop-agentd-test-"));
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
      internalToken: "",
    },
    store,
    new EventHub(),
    new ProviderRegistry(providerDir),
    [new FakeAdapter()],
  );
  return { root, workspace, supervisor, store };
}

async function waitForTerminal(supervisor: RuntimeAgentSupervisor, id: string): Promise<NonNullable<ReturnType<RuntimeAgentSupervisor["getExecution"]>>> {
  for (let index = 0; index < 100; index += 1) {
    const execution = supervisor.getExecution(id);
    if (execution && supervisor.isTerminal(execution.status)) return execution;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Execution did not reach a terminal status");
}

test("executes a Node request, persists events, and distinguishes business artifacts", async () => {
  const { root, workspace, supervisor, store } = await fixture();
  try {
    const outputDir = path.join(workspace, "runs", "one", "outputs");
    const submitted = await supervisor.submit({
      requestId: "request-one",
      instanceId: "instance-one",
      nodeId: "article-writer",
      engine: "sop-native",
      providerId: "test-provider",
      workspace,
      outputDir,
      instruction: "Write the article",
    });
    assert.equal(submitted.created, true);
    const execution = await waitForTerminal(supervisor, submitted.execution.id);
    assert.equal(execution.status, "completed");
    assert.equal(execution.responseText, "done");
    assert.deepEqual(
      execution.artifacts.map((artifact) => [artifact.name, artifact.relayable]),
      [
        ["article.md", true],
        ["manifest.json", false],
      ],
    );
    const eventTypes = supervisor.listEvents(execution.id).map((event) => event.type);
    assert.deepEqual(eventTypes, [
      "execution.queued",
      "execution.started",
      "tool.execution.started",
      "artifact.discovered",
      "artifact.discovered",
      "execution.completed",
    ]);

    const duplicate = await supervisor.submit({
      requestId: "request-one",
      instanceId: "instance-one",
      nodeId: "article-writer",
      engine: "sop-native",
      providerId: "test-provider",
      workspace,
      outputDir,
      instruction: "This must not run twice",
    });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.execution.id, execution.id);
  } finally {
    await supervisor.close();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejects output and material paths that escape the Instance workspace", async () => {
  const { root, workspace, supervisor, store } = await fixture();
  try {
    await assert.rejects(
      supervisor.submit({
        instanceId: "instance-one",
        engine: "sop-native",
        workspace,
        outputDir: path.join(root, "escaped"),
        instruction: "Do not run",
      }),
      /outputDir must be inside/u,
    );
  } finally {
    await supervisor.close();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
