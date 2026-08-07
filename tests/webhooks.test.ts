import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ZodError } from "zod";

import type { AdapterRunContext, AdapterRunResult, AgentCapabilities, AgentRuntimeAdapter } from "../src/contracts.js";
import { EventHub } from "../src/event-hub.js";
import { createHttpServer } from "../src/http-server.js";
import { ProviderRegistry } from "../src/providers.js";
import { SupervisorStore } from "../src/store.js";
import { RuntimeAgentSupervisor } from "../src/supervisor.js";
import { SupervisorError, WebhookRateLimitError } from "../src/util.js";

class WebhookFakeAdapter implements AgentRuntimeAdapter {
  readonly id = "sop-native" as const;
  readonly displayName = "Webhook Fake";
  readonly instructions: string[] = [];

  capabilities(): AgentCapabilities {
    return {
      persistentSessions: true,
      streamingEvents: true,
      toolEvents: false,
      approvals: false,
      steering: false,
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
    this.instructions.push(context.execution.instruction);
    await fs.writeFile(path.join(context.execution.outputDir, "reply.md"), "received\n", "utf8");
    return { sessionId: `native-${context.execution.sessionId}`, nativeRunId: "run-1", responseText: "received" };
  }
}

async function fixture(): Promise<{
  root: string;
  workspace: string;
  supervisor: RuntimeAgentSupervisor;
  store: SupervisorStore;
  adapter: WebhookFakeAdapter;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sop-agentd-webhook-"));
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
  const adapter = new WebhookFakeAdapter();
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
    [adapter],
  );
  return { root, workspace, supervisor, store, adapter };
}

async function waitForTerminal(supervisor: RuntimeAgentSupervisor, id: string): Promise<NonNullable<ReturnType<RuntimeAgentSupervisor["getExecution"]>>> {
  for (let index = 0; index < 200; index += 1) {
    const execution = supervisor.getExecution(id);
    if (execution && supervisor.isTerminal(execution.status)) return execution;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Execution did not reach a terminal status");
}

test("webhook CRUD: secret returned once, listings never leak it, and validation matches spec", async () => {
  const { root, workspace, supervisor, store } = await fixture();
  try {
    const created = await supervisor.createWebhook({
      name: "hook-one",
      engine: "sop-native",
      providerId: "test-provider",
      workspace,
      instructionTemplate: "收到事件,只回两个字:收到。事件内容:{{payload}}",
    });
    assert.match(created.webhook.id, /^wh-[0-9a-f]{8}$/u);
    assert.equal(created.webhook.target, "session", "target defaults to session when omitted");
    assert.equal(typeof created.secret, "string");
    assert(created.secret.length >= 32);
    assert.equal(Object.hasOwn(created.webhook, "secretHash"), false);
    assert.equal(Object.hasOwn(created.webhook, "secret"), false);

    const listed = await supervisor.listWebhooks();
    assert.equal(listed.length, 1);
    const serialized = JSON.stringify(listed);
    assert.equal(serialized.includes(created.secret), false);
    assert.equal(Object.hasOwn(listed[0]!, "secretHash"), false);

    await assert.rejects(
      supervisor.createWebhook({
        name: "hook-one",
        engine: "sop-native",
        providerId: "test-provider",
        workspace,
        instructionTemplate: "dup",
      }),
      (error: unknown) => error instanceof Error && /already exists/u.test(error.message),
    );

    await assert.rejects(
      supervisor.createWebhook({
        name: "hook-bad-engine",
        engine: "codex",
        workspace,
        instructionTemplate: "x",
      }),
      /not installed/u,
    );

    await assert.rejects(
      supervisor.createWebhook({
        name: "hook-bad-workspace",
        engine: "sop-native",
        providerId: "test-provider",
        workspace: path.join(root, "does-not-exist"),
        instructionTemplate: "x",
      }),
      /ENOENT|workspace/u,
    );

    // stored record round-trips through the store directly (internal-only sessionId field).
    assert.equal(store.getWebhook(created.webhook.id)?.name, "hook-one");
  } finally {
    await supervisor.close();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("webhook target: defaults to session, non-session accepted at create but 501 at trigger, invalid value rejected", async () => {
  const { root, workspace, supervisor, store } = await fixture();
  try {
    const taskHook = await supervisor.createWebhook({
      name: "hook-target-task",
      engine: "sop-native",
      providerId: "test-provider",
      workspace,
      instructionTemplate: "x",
      target: "task",
    });
    assert.equal(taskHook.webhook.target, "task");
    assert.equal(store.getWebhook(taskHook.webhook.id)?.target, "task");

    await assert.rejects(
      supervisor.triggerWebhook(taskHook.webhook.id, { secret: taskHook.secret, payload: {}, headers: {} }),
      (error: unknown) =>
        error instanceof SupervisorError &&
        error.httpStatus === 501 &&
        /webhook 目标 task 尚未实现/u.test(error.message),
    );

    await assert.rejects(
      supervisor.createWebhook({
        name: "hook-target-bad",
        engine: "sop-native",
        providerId: "test-provider",
        workspace,
        instructionTemplate: "x",
        target: "not-a-real-target",
      }),
      (error: unknown) => error instanceof ZodError,
    );
  } finally {
    await supervisor.close();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("webhook target: legacy records without a target field fall back to session on read", async () => {
  const { root, workspace, supervisor, store } = await fixture();
  try {
    const created = await supervisor.createWebhook({
      name: "hook-legacy",
      engine: "sop-native",
      providerId: "test-provider",
      workspace,
      instructionTemplate: "x",
    });

    // Simulate a pre-0.5.0 row: strip target from the stored payload_json directly in sqlite.
    const raw = store.getWebhook(created.webhook.id) as unknown as Record<string, unknown>;
    delete raw.target;
    (store as unknown as { database: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).database
      .prepare("UPDATE webhooks SET payload_json = ? WHERE id = ?")
      .run(JSON.stringify(raw), created.webhook.id);

    const fetched = store.getWebhook(created.webhook.id);
    assert.equal(fetched?.target, "session", "getWebhook falls back to session for legacy rows");

    const listed = store.listWebhooks();
    assert.equal(listed.find((webhook) => webhook.id === created.webhook.id)?.target, "session");

    const publicListed = await supervisor.listWebhooks();
    assert.equal(
      publicListed.find((webhook) => webhook.id === created.webhook.id)?.target,
      "session",
      "GET list does not throw and shows session for legacy rows",
    );
  } finally {
    await supervisor.close();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("webhook trigger: auth, disabled, rate limit, session reuse, and ledger event", async () => {
  const { root, workspace, supervisor, store, adapter } = await fixture();
  try {
    const created = await supervisor.createWebhook({
      name: "hook-two",
      engine: "sop-native",
      providerId: "test-provider",
      workspace,
      instructionTemplate: "收到事件,只回两个字:收到。事件内容:{{payload}}",
      minIntervalMs: 200,
    });
    const { secret, webhook } = { secret: created.secret, webhook: created.webhook };

    await assert.rejects(
      supervisor.triggerWebhook(webhook.id, { secret: "wrong-secret", payload: {}, headers: {} }),
      (error: unknown) => error instanceof Error && /Invalid webhook credentials/u.test(error.message),
    );
    await assert.rejects(
      supervisor.triggerWebhook("wh-doesnotexist", { secret, payload: {}, headers: {} }),
      (error: unknown) => error instanceof Error && /Invalid webhook credentials/u.test(error.message),
    );

    const first = await supervisor.triggerWebhook(webhook.id, {
      secret,
      payload: { hello: "world" },
      headers: { "x-github-event": "push" },
    });
    const firstExecution = await waitForTerminal(supervisor, first.executionId);
    assert.equal(firstExecution.status, "completed");
    assert.match(adapter.instructions[0]!, /\{"hello":"world"\}/u);

    const events = supervisor.listAllEvents();
    const triggeredEvent = events.find((event) => event.type === "webhook.triggered");
    assert(triggeredEvent);
    assert.equal(triggeredEvent?.subject.kind, "webhook");
    assert.equal(triggeredEvent?.subject.id, webhook.id);
    assert.equal((triggeredEvent?.data as { name: string }).name, "hook-two");

    // Rate limit: immediate second trigger must be rejected as 429-equivalent.
    await assert.rejects(
      supervisor.triggerWebhook(webhook.id, { secret, payload: {}, headers: {} }),
      (error: unknown) => error instanceof WebhookRateLimitError,
    );

    await new Promise((resolve) => setTimeout(resolve, 250));
    const second = await supervisor.triggerWebhook(webhook.id, { secret, payload: { n: 2 }, headers: {} });
    await waitForTerminal(supervisor, second.executionId);
    assert.equal(second.sessionId, first.sessionId, "webhook must reuse its resident session");

    const stored = store.getWebhook(webhook.id);
    assert.equal(stored?.triggerCount, 2);
    assert.equal(stored?.sessionId, first.sessionId);

    await supervisor.setWebhookEnabled(webhook.id, { enabled: false });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await assert.rejects(
      supervisor.triggerWebhook(webhook.id, { secret, payload: {}, headers: {} }),
      (error: unknown) => error instanceof Error && /is disabled/u.test(error.message),
    );

    await supervisor.deleteWebhook(webhook.id);
    assert.equal(store.getWebhook(webhook.id), undefined);
  } finally {
    await supervisor.close();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("webhook trigger over HTTP: secret header auth, 401/403/429 status codes, and 202 on success", async () => {
  const { root, workspace, supervisor, store } = await fixture();
  const server = createHttpServer(supervisor);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const adminHeaders = { authorization: "Bearer secret", "content-type": "application/json" };
  try {
    const createResponse = await fetch(`${base}/v1/webhooks`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "http-hook",
        engine: "sop-native",
        providerId: "test-provider",
        workspace,
        instructionTemplate: "收到:{{payload}} / {{headers}}",
        minIntervalMs: 100,
      }),
    });
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { webhook: { id: string }; secret: string };

    const listResponse = await fetch(`${base}/v1/webhooks`, { headers: { authorization: "Bearer secret" } });
    const listText = await listResponse.text();
    assert.equal(listText.includes(created.secret), false);

    const wrongSecretResponse = await fetch(`${base}/v1/hooks/${created.webhook.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": "nope" },
      body: JSON.stringify({ a: 1 }),
    });
    assert.equal(wrongSecretResponse.status, 401);

    const okResponse = await fetch(`${base}/v1/hooks/${created.webhook.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": created.secret },
      body: JSON.stringify({ a: 1 }),
    });
    assert.equal(okResponse.status, 202);
    const okBody = (await okResponse.json()) as { executionId: string; sessionId: string };
    assert(okBody.executionId);
    assert(okBody.sessionId);

    const rateLimitedResponse = await fetch(`${base}/v1/hooks/${created.webhook.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": created.secret },
      body: JSON.stringify({ a: 2 }),
    });
    assert.equal(rateLimitedResponse.status, 429);
    const rateLimitedBody = (await rateLimitedResponse.json()) as { retryAfterMs: number };
    assert(rateLimitedBody.retryAfterMs > 0);

    await fetch(`${base}/v1/webhooks/${created.webhook.id}/enabled`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ enabled: false }),
    });
    const disabledResponse = await fetch(`${base}/v1/hooks/${created.webhook.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": created.secret },
      body: JSON.stringify({}),
    });
    assert.equal(disabledResponse.status, 403);

    const deleteResponse = await fetch(`${base}/v1/webhooks/${created.webhook.id}`, {
      method: "DELETE",
      headers: { authorization: "Bearer secret" },
    });
    assert.equal(deleteResponse.status, 200);
  } finally {
    server.close();
    await supervisor.close();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
