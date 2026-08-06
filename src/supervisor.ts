import fs from "node:fs/promises";
import path from "node:path";

import { collectArtifacts } from "./artifacts.js";
import type { AgentdConfig } from "./config.js";
import {
  createExecutionSchema,
  createSessionSchema,
  createTurnSchema,
  resolveApprovalSchema,
  setSessionProviderSchema,
  steerExecutionSchema,
  type AgentRuntimeAdapter,
  type CreateExecutionInput,
  type ExecutionRecord,
  type RuntimeEvent,
  type SessionRecord,
} from "./contracts.js";
import { EventHub } from "./event-hub.js";
import { ProviderRegistry } from "./providers.js";
import { SupervisorStore } from "./store.js";
import { assertPathWithin, ensureDir, errorMessage, newId, nowIso, SupervisorError } from "./util.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
export const SUPERVISOR_VERSION = "0.4.0";
export const PROTOCOL_VERSION = 1;

export class RuntimeAgentSupervisor {
  private readonly adapters = new Map<string, AgentRuntimeAdapter>();
  private readonly queued: string[] = [];
  private readonly abortControllers = new Map<string, AbortController>();
  private activeCount = 0;
  private closing = false;

  constructor(
    readonly config: AgentdConfig,
    readonly store: SupervisorStore,
    readonly events: EventHub,
    readonly providers: ProviderRegistry,
    adapters: AgentRuntimeAdapter[],
  ) {
    for (const adapter of adapters) {
      this.adapters.set(adapter.id, adapter);
    }
  }

  private readonly startedAtIso = nowIso();

  recover(): { executions: number; sessions: number } {
    return {
      executions: this.store.recoverInterruptedExecutions(),
      sessions: this.store.reconcileSessions(),
    };
  }

  listAdapters(): Array<{ id: string; displayName: string; capabilities: ReturnType<AgentRuntimeAdapter["capabilities"]> }> {
    return [...this.adapters.values()].map((adapter) => ({
      id: adapter.id,
      displayName: adapter.displayName,
      capabilities: adapter.capabilities(),
    }));
  }

  async probeAdapters(): Promise<Array<{ id: string; ok: boolean; reason: string; detail: Record<string, unknown> }>> {
    return await Promise.all(
      [...this.adapters.values()].map(async (adapter) => ({ id: adapter.id, ...(await adapter.probe()) })),
    );
  }

  async createSession(rawInput: unknown): Promise<{ session: SessionRecord; created: boolean }> {
    if (this.closing) {
      throw new Error("Runtime Agent Supervisor is shutting down");
    }
    const input = createSessionSchema.parse(rawInput);
    const requestId = input.requestId || newId("request");
    const existing = this.store.getSessionByRequestId(requestId);
    if (existing) {
      return { session: existing, created: false };
    }
    if (!this.adapters.has(input.engine)) {
      throw new SupervisorError(`Agent engine ${input.engine} is not installed in this Runtime Supervisor`, 409);
    }
    const workspace = path.resolve(input.workspace);
    const stat = await fs.stat(workspace);
    if (!stat.isDirectory()) throw new Error("workspace must be a directory");
    if (input.engine === "sop-native") {
      const provider = input.providerId ? await this.providers.get(input.providerId) : undefined;
      if (!provider) {
        throw new Error(`Provider Profile ${input.providerId || "<missing>"} is not configured`);
      }
    }
    const timestamp = nowIso();
    const session: SessionRecord = {
      id: newId("session"),
      requestId,
      instanceId: input.instanceId,
      engine: input.engine,
      providerId: input.providerId ?? "",
      workspace,
      title: input.title,
      status: "idle",
      nativeSessionId: "",
      turnCount: 0,
      activeExecutionId: "",
      lastExecutionId: "",
      createdAt: timestamp,
      lastActivityAt: timestamp,
      metadata: { ...input.metadata },
    };
    this.store.createSession(session);
    await this.emitSessionEvent(session, "session.created", `${session.engine} session created`, {
      instanceId: session.instanceId,
      workspace: session.workspace,
    });
    return { session, created: true };
  }

  getSession(id: string): SessionRecord | undefined {
    return this.store.getSession(id);
  }

  listSessions(limit?: number, instanceId?: string): SessionRecord[] {
    return this.store.listSessions(limit, instanceId);
  }

  listSessionExecutions(sessionId: string, limit?: number): ExecutionRecord[] {
    this.requiredSession(sessionId);
    return this.store.listExecutionsBySession(sessionId, limit);
  }

  async closeSession(sessionId: string): Promise<SessionRecord> {
    const session = this.requiredSession(sessionId);
    if (session.status === "closed") {
      return session;
    }
    if (session.activeExecutionId) {
      const active = this.store.getExecution(session.activeExecutionId);
      if (active && !this.isTerminal(active.status)) {
        throw new SupervisorError(
          `Session ${sessionId} still has a running turn ${active.id}; cancel it before closing`,
          409,
        );
      }
    }
    session.status = "closed";
    session.activeExecutionId = "";
    session.lastActivityAt = nowIso();
    this.store.saveSession(session);
    await this.emitSessionEvent(session, "session.closed", "Session closed", { turnCount: session.turnCount });
    return session;
  }

  async setSessionProvider(sessionId: string, rawInput: unknown): Promise<{ session: SessionRecord; deferred: boolean }> {
    const session = this.requiredSession(sessionId);
    const input = setSessionProviderSchema.parse(rawInput);
    if (session.engine === "sop-native") {
      const provider = await this.providers.get(input.providerId);
      if (!provider) {
        throw new Error(`Provider Profile ${input.providerId} is not configured`);
      }
    }
    const oldProviderId = session.providerId;
    const active = session.activeExecutionId ? this.store.getExecution(session.activeExecutionId) : undefined;
    const deferred = Boolean(active && !this.isTerminal(active.status));
    session.providerId = input.providerId;
    session.lastActivityAt = nowIso();
    this.store.saveSession(session);
    await this.emitSessionEvent(
      session,
      "session.provider.changed",
      `Session provider changed ${oldProviderId || "<none>"} -> ${session.providerId}`,
      { oldProviderId, newProviderId: session.providerId, deferred },
    );
    return { session, deferred };
  }

  async createTurn(
    sessionId: string,
    rawInput: unknown,
  ): Promise<{ execution: ExecutionRecord; created: boolean; session: SessionRecord }> {
    const session = this.requiredSession(sessionId);
    if (session.status === "closed") {
      throw new SupervisorError(`Session ${sessionId} is closed`, 409);
    }
    const input = createTurnSchema.parse(rawInput);
    const requestId = input.requestId || newId("request");
    const existing = this.store.getByRequestId(requestId);
    if (existing) {
      return { execution: existing, created: false, session };
    }
    if (session.activeExecutionId) {
      const active = this.store.getExecution(session.activeExecutionId);
      if (active && !this.isTerminal(active.status)) {
        throw new SupervisorError(`Session ${sessionId} already has a running turn ${active.id}`, 409);
      }
    }
    const turnIndex = session.turnCount + 1;
    const outputDir =
      input.outputDir ??
      path.join(session.workspace, ".sop-agentd", "turns", `${String(turnIndex).padStart(4, "0")}-${newId("t").slice(-8)}`);
    const submitInput: Record<string, unknown> = {
      requestId,
      instanceId: session.instanceId,
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      engine: session.engine,
      workspace: session.workspace,
      outputDir,
      instruction: input.instruction,
      materials: input.materials,
      ...(input.skill ? { skill: input.skill } : {}),
      ...(session.providerId ? { providerId: session.providerId } : {}),
      sessionPolicy: session.nativeSessionId ? "resume" : "persistent",
      sessionId: session.nativeSessionId || session.id,
      timeoutMs: input.timeoutMs,
      metadata: { ...input.metadata, sessionRef: session.id, turnIndex },
    };
    const submitted = await this.submit(submitInput, { sessionRef: session.id });
    return { ...submitted, session: this.requiredSession(sessionId) };
  }

  async submit(
    rawInput: unknown,
    internal?: { sessionRef?: string },
  ): Promise<{ execution: ExecutionRecord; created: boolean }> {
    if (this.closing) {
      throw new Error("Runtime Agent Supervisor is shutting down");
    }
    const input = createExecutionSchema.parse(rawInput);
    const requestId = input.requestId || newId("request");
    const existing = this.store.getByRequestId(requestId);
    if (existing) {
      return { execution: existing, created: false };
    }
    if (!this.adapters.has(input.engine)) {
      throw new Error(`Agent engine ${input.engine} is not installed in this Runtime Supervisor`);
    }

    const normalized = await this.validateInput(input);
    const provider = input.providerId ? await this.providers.get(input.providerId) : undefined;
    if (input.engine === "sop-native" && !provider) {
      throw new Error(`Provider Profile ${input.providerId || "<missing>"} is not configured`);
    }
    const timestamp = nowIso();
    const execution: ExecutionRecord = {
      id: newId("agent-execution"),
      requestId,
      instanceId: input.instanceId,
      nodeId: input.nodeId ?? "",
      sessionRef: internal?.sessionRef ?? "",
      engine: input.engine,
      status: "queued",
      workspace: normalized.workspace,
      outputDir: normalized.outputDir,
      sessionId: input.sessionId ?? newId("session"),
      nativeRunId: "",
      instruction: input.instruction,
      materials: normalized.materials,
      ...(normalized.skill ? { skill: normalized.skill } : {}),
      ...(provider ? { provider } : {}),
      sessionPolicy: input.sessionPolicy,
      timeoutMs: input.timeoutMs,
      createdAt: timestamp,
      startedAt: "",
      finishedAt: "",
      error: "",
      responseText: "",
      artifacts: [],
      metadata: { ...input.metadata },
    };
    this.store.createExecution(execution);
    if (execution.sessionRef) {
      const session = this.store.getSession(execution.sessionRef);
      if (session) {
        session.status = "active";
        session.activeExecutionId = execution.id;
        session.turnCount += 1;
        if (!session.title) {
          session.title = execution.instruction.slice(0, 80);
        }
        session.lastActivityAt = timestamp;
        this.store.saveSession(session);
      }
    }
    await this.emit(execution, {
      type: "execution.queued",
      status: "queued",
      producer: "runtime-agent-supervisor",
      subject: { kind: "execution", id: execution.id },
      summary: `${execution.engine} execution queued`,
      data: { queueDepth: this.queued.length + 1, sessionRef: execution.sessionRef },
    });
    this.queued.push(execution.id);
    this.pump();
    return { execution, created: true };
  }

  async steer(executionId: string, rawInput: unknown): Promise<ExecutionRecord> {
    const { message } = steerExecutionSchema.parse(rawInput);
    const execution = this.requiredExecution(executionId);
    if (this.isTerminal(execution.status)) {
      throw new SupervisorError(`Execution ${executionId} already finished (${execution.status})`, 409);
    }
    if (execution.status === "queued") {
      throw new SupervisorError(`Execution ${executionId} has not started yet`, 409);
    }
    const adapter = this.adapters.get(execution.engine);
    if (!adapter?.capabilities().steering || !adapter.steer) {
      throw new SupervisorError(`Agent engine ${execution.engine} does not support steering`, 409);
    }
    await adapter.steer(executionId, message);
    await this.emit(execution, {
      type: "execution.steered",
      status: execution.status,
      producer: "runtime-agent-supervisor",
      subject: { kind: "execution", id: execution.id },
      summary: "Operator steered the running execution",
      data: { message },
    });
    return this.requiredExecution(executionId);
  }

  async resolveApproval(executionId: string, rawInput: unknown): Promise<ExecutionRecord> {
    const input = resolveApprovalSchema.parse(rawInput);
    const execution = this.requiredExecution(executionId);
    if (this.isTerminal(execution.status)) {
      throw new SupervisorError(`Execution ${executionId} already finished (${execution.status})`, 409);
    }
    const adapter = this.adapters.get(execution.engine);
    if (!adapter?.capabilities().approvals || !adapter.resolveApproval) {
      throw new SupervisorError(`Agent engine ${execution.engine} does not support approvals`, 409);
    }
    await adapter.resolveApproval(executionId, {
      approvalId: input.approvalId ?? "",
      decision: input.decision,
      note: input.note,
    });
    await this.emit(execution, {
      type: "execution.approval_resolved",
      status: execution.status,
      producer: "runtime-agent-supervisor",
      subject: { kind: "approval", id: input.approvalId ?? execution.id },
      summary: `Approval ${input.decision === "approve" ? "granted" : "rejected"}`,
      data: { decision: input.decision, note: input.note },
    });
    return this.requiredExecution(executionId);
  }

  async waitForTerminal(
    executionId: string,
    timeoutMs: number,
  ): Promise<{ execution: ExecutionRecord; timedOut: boolean }> {
    const execution = this.requiredExecution(executionId);
    if (this.isTerminal(execution.status)) {
      return { execution, timedOut: false };
    }
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (timedOut: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve({ execution: this.requiredExecution(executionId), timedOut });
      };
      const unsubscribe = this.events.subscribe(executionId, (event) => {
        if (this.isTerminal(event.status)) finish(false);
      });
      const timer = setTimeout(() => finish(true), timeoutMs);
      timer.unref();
      const current = this.requiredExecution(executionId);
      if (this.isTerminal(current.status)) finish(false);
    });
  }

  async cancel(executionId: string): Promise<ExecutionRecord> {
    const execution = this.requiredExecution(executionId);
    if (TERMINAL_STATUSES.has(execution.status)) {
      return execution;
    }
    if (execution.status === "queued") {
      const index = this.queued.indexOf(executionId);
      if (index >= 0) this.queued.splice(index, 1);
      execution.status = "cancelled";
      execution.finishedAt = nowIso();
      this.store.saveExecution(execution);
      await this.emit(execution, {
        type: "execution.cancelled",
        status: "cancelled",
        producer: "runtime-agent-supervisor",
        subject: { kind: "execution", id: execution.id },
        summary: "Execution cancelled before it started",
        data: {},
      });
      this.syncSessionAfterTurn(execution);
      return execution;
    }
    this.abortControllers.get(executionId)?.abort(new Error("Execution cancelled"));
    await this.adapters.get(execution.engine)?.cancel?.(executionId);
    return this.requiredExecution(executionId);
  }

  getExecution(id: string): ExecutionRecord | undefined {
    return this.store.getExecution(id);
  }

  listExecutions(limit?: number): ExecutionRecord[] {
    return this.store.listExecutions(limit);
  }

  listEvents(executionId: string, afterId?: number, limit?: number): RuntimeEvent[] {
    this.requiredExecution(executionId);
    return this.store.listEvents(executionId, afterId, limit);
  }

  listAllEvents(afterId?: number, limit?: number): RuntimeEvent[] {
    return this.store.listAllEvents(afterId, limit);
  }

  statusSnapshot(): Record<string, unknown> {
    const active = this.store.listActiveExecutions();
    return {
      ok: true,
      service: "sop-runtime-agentd",
      version: SUPERVISOR_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      observedAt: nowIso(),
      startedAt: this.startedAtIso,
      uptimeSeconds: Math.floor(process.uptime()),
      scheduler: {
        accepting: !this.closing,
        active: this.activeCount,
        queued: this.queued.length,
        maxConcurrent: this.config.maxConcurrent,
        availableSlots: Math.max(0, this.config.maxConcurrent - this.activeCount),
      },
      sessions: this.store.sessionCounts(),
      activeExecutions: active.map((execution) => ({
        id: execution.id,
        engine: execution.engine,
        status: execution.status,
        instanceId: execution.instanceId,
        nodeId: execution.nodeId,
        sessionRef: execution.sessionRef,
        createdAt: execution.createdAt,
        startedAt: execution.startedAt,
      })),
      lastEventId: this.store.lastEventId(),
    };
  }

  healthSnapshot(): Record<string, unknown> {
    return {
      ok: true,
      service: "sop-runtime-agentd",
      version: SUPERVISOR_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      uptimeSeconds: Math.floor(process.uptime()),
      scheduler: {
        accepting: !this.closing,
        active: this.activeCount,
        queued: this.queued.length,
        maxConcurrent: this.config.maxConcurrent,
        availableSlots: Math.max(0, this.config.maxConcurrent - this.activeCount),
      },
      storage: {
        driver: "sqlite",
        path: this.config.databasePath,
        ...this.store.health(),
      },
      adapters: this.listAdapters(),
    };
  }

  isTerminal(status: string): boolean {
    return TERMINAL_STATUSES.has(status);
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.abortControllers.keys()].map(async (id) => await this.cancel(id)));
  }

  private async validateInput(input: CreateExecutionInput): Promise<{
    workspace: string;
    outputDir: string;
    materials: CreateExecutionInput["materials"];
    skill?: CreateExecutionInput["skill"];
  }> {
    const workspace = path.resolve(input.workspace);
    const stat = await fs.stat(workspace);
    if (!stat.isDirectory()) throw new Error("workspace must be a directory");
    const outputDir = assertPathWithin(workspace, input.outputDir, "outputDir");
    await ensureDir(outputDir);
    const materials = input.materials.map((material) => {
      if (material.kind !== "file" || !material.path) return material;
      return { ...material, path: assertPathWithin(workspace, material.path, `material ${material.id}`) };
    });
    const skill = input.skill
      ? { ...input.skill, path: assertPathWithin(workspace, input.skill.path, "skill path") }
      : undefined;
    if (skill) {
      const skillStat = await fs.stat(skill.path);
      if (!skillStat.isDirectory() && path.basename(skill.path) !== "SKILL.md") {
        throw new Error("skill path must be a Skill directory or SKILL.md");
      }
    }
    return { workspace, outputDir, materials, ...(skill ? { skill } : {}) };
  }

  private requiredExecution(id: string): ExecutionRecord {
    const execution = this.store.getExecution(id);
    if (!execution) throw new SupervisorError(`Execution ${id} was not found`, 404);
    return execution;
  }

  private requiredSession(id: string): SessionRecord {
    const session = this.store.getSession(id);
    if (!session) throw new SupervisorError(`Session ${id} was not found`, 404);
    return session;
  }

  private syncSessionAfterTurn(execution: ExecutionRecord): void {
    if (!execution.sessionRef || !this.isTerminal(execution.status)) return;
    const session = this.store.getSession(execution.sessionRef);
    if (!session) return;
    if (session.activeExecutionId === execution.id) {
      session.activeExecutionId = "";
    }
    session.lastExecutionId = execution.id;
    if (execution.status === "completed" && execution.sessionId) {
      session.nativeSessionId = execution.sessionId;
    }
    if (session.status === "active") {
      session.status = "idle";
    }
    session.lastActivityAt = nowIso();
    this.store.saveSession(session);
  }

  private async emitSessionEvent(
    session: SessionRecord,
    type: string,
    summary: string,
    data: Record<string, unknown>,
  ): Promise<RuntimeEvent> {
    const stored = this.store.appendEvent({
      executionId: "",
      type,
      status: session.status,
      producer: "runtime-agent-supervisor",
      subject: { kind: "session", id: session.id },
      summary,
      data,
      occurredAt: nowIso(),
    });
    this.events.publish(stored);
    return stored;
  }

  private pump(): void {
    while (!this.closing && this.activeCount < this.config.maxConcurrent && this.queued.length > 0) {
      const executionId = this.queued.shift();
      if (!executionId) break;
      const execution = this.store.getExecution(executionId);
      if (!execution || execution.status !== "queued") continue;
      this.activeCount += 1;
      void this.runExecution(execution).finally(() => {
        this.activeCount -= 1;
        this.pump();
      });
    }
  }

  private async runExecution(execution: ExecutionRecord): Promise<void> {
    const adapter = this.adapters.get(execution.engine);
    if (!adapter) return;
    const controller = new AbortController();
    this.abortControllers.set(execution.id, controller);
    const timeout = setTimeout(() => controller.abort(new Error(`Execution timed out after ${execution.timeoutMs}ms`)), execution.timeoutMs);
    timeout.unref();
    try {
      execution.status = "running";
      execution.startedAt = nowIso();
      this.store.saveExecution(execution);
      await this.emit(execution, {
        type: "execution.started",
        status: "running",
        producer: "runtime-agent-supervisor",
        subject: { kind: "execution", id: execution.id },
        summary: `${adapter.displayName} started`,
        data: { adapter: adapter.id, sessionId: execution.sessionId },
      });
      const result = await adapter.run({
        execution,
        signal: controller.signal,
        emit: async (event) => await this.emit(execution, event),
      });
      if (controller.signal.aborted) throw controller.signal.reason;
      execution.sessionId = result.sessionId;
      execution.nativeRunId = result.nativeRunId;
      execution.responseText = result.responseText;
      if (result.reasoningText) execution.reasoningText = result.reasoningText;
      execution.artifacts = await collectArtifacts(execution.outputDir);
      if (execution.skill) {
        if (!execution.artifacts.some((artifact) => artifact.name === "manifest.json")) {
          throw new Error("Bound Skill completed without manifest.json");
        }
        if (!execution.artifacts.some((artifact) => artifact.relayable)) {
          throw new Error("Bound Skill completed without a business artifact");
        }
      }
      for (const artifact of execution.artifacts) {
        await this.emit(execution, {
          type: "artifact.discovered",
          status: "running",
          producer: "runtime-agent-supervisor",
          subject: { kind: "artifact", id: artifact.id },
          summary: `${artifact.name} collected`,
          data: artifact,
        });
      }
      execution.status = "completed";
      execution.finishedAt = nowIso();
      this.store.saveExecution(execution);
      await this.emit(execution, {
        type: "execution.completed",
        status: "completed",
        producer: "runtime-agent-supervisor",
        subject: { kind: "execution", id: execution.id },
        summary: `Execution completed with ${execution.artifacts.filter((item) => item.relayable).length} business artifacts`,
        data: {
          sessionId: execution.sessionId,
          nativeRunId: execution.nativeRunId,
          artifactIds: execution.artifacts.map((item) => item.id),
        },
      });
    } catch (error) {
      const cancelled = controller.signal.aborted && String(controller.signal.reason).includes("cancelled");
      execution.status = cancelled ? "cancelled" : "failed";
      execution.finishedAt = nowIso();
      execution.error = errorMessage(controller.signal.aborted ? controller.signal.reason : error);
      execution.artifacts = await collectArtifacts(execution.outputDir);
      this.store.saveExecution(execution);
      await this.emit(execution, {
        type: cancelled ? "execution.cancelled" : "execution.failed",
        status: execution.status,
        producer: "runtime-agent-supervisor",
        subject: { kind: "execution", id: execution.id },
        summary: execution.error,
        data: { partialArtifactIds: execution.artifacts.map((item) => item.id) },
      });
    } finally {
      clearTimeout(timeout);
      this.abortControllers.delete(execution.id);
      this.syncSessionAfterTurn(execution);
    }
  }

  private async emit(
    execution: ExecutionRecord,
    event: Omit<RuntimeEvent, "id" | "executionId" | "occurredAt">,
  ): Promise<RuntimeEvent> {
    const stored = this.store.appendEvent({ ...event, executionId: execution.id, occurredAt: nowIso() });
    this.events.publish(stored);
    return stored;
  }
}
