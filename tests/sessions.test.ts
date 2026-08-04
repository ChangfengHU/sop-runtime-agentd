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
  ExecutionRecord,
} from "../src/contracts.js";
import { EventHub } from "../src/event-hub.js";
import { ProviderRegistry } from "../src/providers.js";
import { SupervisorStore } from "../src/store.js";
import { RuntimeAgentSupervisor } from "../src/supervisor.js";

class SessionFakeAdapter implements AgentRuntimeAdapter {
  readonly id = "sop-native" as const;
  readonly displayName = "Session Fake";
  readonly seenPolicies: Array<{ policy: string; sessionId: string }> = [];
  readonly steered: Array<{ executionId: string; message: string }> = [];
  private release: (() => void) | undefined;

  constructor(private readonly options: { steering: boolean; holdUntilSteered?: boolean } = { steering: true }) {}

  capabilities(): AgentCapabilities {
    return {
      persistentSessions: true,
      streamingEvents: true,
      toolEvents: false,
      approvals: false,
      steering: this.options.steering,
      resume: true,
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
    const { execution } = context;
    this.seenPolicies.push({ policy: execution.sessionPolicy, sessionId: execution.sessionId });
    if (this.options.holdUntilSteered) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    await fs.writeFile(path.join(execution.outputDir, "answer.md"), "turn done\n", "utf8");
    return { sessionId: `native-${execution.sessionId}`, nativeRunId: "run-1", responseText: "turn done" };
  }

  async steer(executionId: string, message: string): Promise<void> {
    this.steered.push({ executionId, message });
    this.release?.();
    this.release = undefined;
  }
}

async function fixture(adapter: AgentRuntimeAdapter): Promise<{
  root: string;
  workspace: string;
  supervisor: RuntimeAgentSupervisor;
  store: SupervisorStore;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sop-agentd-session-"));
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
    [adapter],
  );
  return { root, workspace, supervisor, store };
}

async function waitForTerminal(supervisor: RuntimeAgentSupervisor, id: string): Promise<ExecutionRecord> {
  for (let index = 0; index < 200; index += 1) {
    const execution = supervisor.getExecution(id);
    if (execution && supervisor.isTerminal(execution.status)) return execution;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Execution did not reach a terminal status");
}

test("sessions are first-class: turns share one ledger and resume the native session", async () => {
  const adapter = new SessionFakeAdapter({ steering: true });
  const { root, workspace, supervisor, store } = await fixture(adapter);
  try {
    const created = await supervisor.createSession({
      requestId: "session-request-1",
      instanceId: "instance-one",
      engine: "sop-native",
      providerId: "test-provider",
      workspace,
    });
    assert.equal(created.created, true);
    assert.equal(created.session.status, "idle");

    const duplicate = await supervisor.createSession({
      requestId: "session-request-1",
      instanceId: "instance-one",
      engine: "sop-native",
      providerId: "test-provider",
      workspace,
    });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.session.id, created.session.id);

    const firstTurn = await supervisor.createTurn(created.session.id, { instruction: "First question" });
    assert.equal(firstTurn.created, true);
    assert.equal(firstTurn.session.status, "active");
    assert.equal(firstTurn.session.turnCount, 1);
    assert.equal(firstTurn.session.title, "First question");
    const firstDone = await waitForTerminal(supervisor, firstTurn.execution.id);
    assert.equal(firstDone.status, "completed");
    assert.equal(firstDone.sessionRef, created.session.id);

    const afterFirst = supervisor.getSession(created.session.id);
    assert.equal(afterFirst?.status, "idle");
    assert.equal(afterFirst?.nativeSessionId, `native-${created.session.id}`);
    assert.equal(afterFirst?.lastExecutionId, firstTurn.execution.id);

    const secondTurn = await supervisor.createTurn(created.session.id, { instruction: "Follow-up question" });
    await waitForTerminal(supervisor, secondTurn.execution.id);
    assert.deepEqual(
      adapter.seenPolicies.map((entry) => entry.policy),
      ["persistent", "resume"],
    );
    assert.equal(adapter.seenPolicies[1]?.sessionId, `native-${created.session.id}`);

    const turns = supervisor.listSessionExecutions(created.session.id);
    assert.deepEqual(
      turns.map((turn) => turn.id),
      [firstTurn.execution.id, secondTurn.execution.id],
    );

    const aggregate = supervisor.listAllEvents();
    assert.equal(aggregate.some((event) => event.type === "session.created"), true);
    assert.equal(aggregate.every((event, index) => index === 0 || event.id > aggregate[index - 1]!.id), true);

    const closed = await supervisor.closeSession(created.session.id);
    assert.equal(closed.status, "closed");
    await assert.rejects(
      supervisor.createTurn(created.session.id, { instruction: "Too late" }),
      /is closed/u,
    );
  } finally {
    await supervisor.close();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("steer reaches the adapter mid-run and wait resolves on the terminal status", async () => {
  const adapter = new SessionFakeAdapter({ steering: true, holdUntilSteered: true });
  const { root, workspace, supervisor, store } = await fixture(adapter);
  try {
    const { session } = await supervisor.createSession({
      instanceId: "instance-one",
      engine: "sop-native",
      providerId: "test-provider",
      workspace,
    });
    const turn = await supervisor.createTurn(session.id, { instruction: "Long running turn" });
    for (let index = 0; index < 200; index += 1) {
      if (supervisor.getExecution(turn.execution.id)?.status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const waitPromise = supervisor.waitForTerminal(turn.execution.id, 5_000);
    await supervisor.steer(turn.execution.id, { message: "Answer in Chinese instead" });
    assert.deepEqual(adapter.steered, [{ executionId: turn.execution.id, message: "Answer in Chinese instead" }]);
    const waited = await waitPromise;
    assert.equal(waited.timedOut, false);
    assert.equal(waited.execution.status, "completed");
    const events = supervisor.listEvents(turn.execution.id).map((event) => event.type);
    assert.equal(events.includes("execution.steered"), true);
  } finally {
    await supervisor.close();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("steer and approvals are capability-gated with honest errors", async () => {
  const adapter = new SessionFakeAdapter({ steering: false, holdUntilSteered: true });
  const { root, workspace, supervisor, store } = await fixture(adapter);
  try {
    const { session } = await supervisor.createSession({
      instanceId: "instance-one",
      engine: "sop-native",
      providerId: "test-provider",
      workspace,
    });
    const turn = await supervisor.createTurn(session.id, { instruction: "Hold" });
    for (let index = 0; index < 200; index += 1) {
      if (supervisor.getExecution(turn.execution.id)?.status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await assert.rejects(
      supervisor.steer(turn.execution.id, { message: "nope" }),
      /does not support steering/u,
    );
    await assert.rejects(
      supervisor.resolveApproval(turn.execution.id, { decision: "approve" }),
      /does not support approvals/u,
    );
    await supervisor.cancel(turn.execution.id);
  } finally {
    await supervisor.close();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("boot reconciliation marks orphaned running turns failed(process_lost) and settles sessions", async () => {
  const adapter = new SessionFakeAdapter({ steering: true, holdUntilSteered: true });
  const { root, workspace, supervisor, store } = await fixture(adapter);
  try {
    const { session } = await supervisor.createSession({
      instanceId: "instance-one",
      engine: "sop-native",
      providerId: "test-provider",
      workspace,
    });
    const turn = await supervisor.createTurn(session.id, { instruction: "Will be orphaned" });
    for (let index = 0; index < 200; index += 1) {
      if (supervisor.getExecution(turn.execution.id)?.status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Simulate a process crash: reopen the same database as a fresh gateway would.
    const reopened = new SupervisorStore(path.join(root, "supervisor.db"));
    const reconciledExecutions = reopened.recoverInterruptedExecutions();
    const reconciledSessions = reopened.reconcileSessions();
    assert.equal(reconciledExecutions, 1);
    assert.equal(reconciledSessions, 1);
    const orphan = reopened.getExecution(turn.execution.id);
    assert.equal(orphan?.status, "failed");
    assert.match(orphan?.error ?? "", /process_lost/u);
    const settledSession = reopened.getSession(session.id);
    assert.equal(settledSession?.status, "idle");
    assert.equal(settledSession?.activeExecutionId, "");
    const events = reopened.listAllEvents();
    assert.equal(events.some((event) => event.type === "execution.reconciled"), true);
    assert.equal(events.some((event) => event.type === "session.reconciled"), true);
    reopened.close();
  } finally {
    await supervisor.close();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
