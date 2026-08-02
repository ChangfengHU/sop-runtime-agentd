import fs from "node:fs/promises";
import path from "node:path";

import { collectArtifacts } from "./artifacts.js";
import type { AgentdConfig } from "./config.js";
import {
  createExecutionSchema,
  type AgentRuntimeAdapter,
  type CreateExecutionInput,
  type ExecutionRecord,
  type RuntimeEvent,
} from "./contracts.js";
import { EventHub } from "./event-hub.js";
import { ProviderRegistry } from "./providers.js";
import { SupervisorStore } from "./store.js";
import { assertPathWithin, ensureDir, errorMessage, newId, nowIso } from "./util.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
export const SUPERVISOR_VERSION = "0.1.0";

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

  recover(): number {
    return this.store.recoverInterruptedExecutions();
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

  async submit(rawInput: unknown): Promise<{ execution: ExecutionRecord; created: boolean }> {
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
    await this.emit(execution, {
      type: "execution.queued",
      status: "queued",
      producer: "runtime-agent-supervisor",
      subject: { kind: "execution", id: execution.id },
      summary: `${execution.engine} execution queued`,
      data: { queueDepth: this.queued.length + 1 },
    });
    this.queued.push(execution.id);
    this.pump();
    return { execution, created: true };
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

  healthSnapshot(): Record<string, unknown> {
    return {
      ok: true,
      service: "sop-runtime-agentd",
      version: SUPERVISOR_VERSION,
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

  isTerminal(status: ExecutionRecord["status"]): boolean {
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
    if (!execution) throw new Error(`Execution ${id} was not found`);
    return execution;
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
