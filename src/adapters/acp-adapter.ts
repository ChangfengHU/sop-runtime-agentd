import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { AcpClient, type AcpNotification } from "../acp/acp-client.js";
import type {
  AdapterRunContext,
  AdapterRunResult,
  AgentCapabilities,
  AgentRuntimeAdapter,
  EngineId,
} from "../contracts.js";
import { errorMessage, newId } from "../util.js";

const REASONING_TEXT_MAX_CHARS = 80_000;
const REASONING_TEXT_TRUNCATED_CHARS = 60_000;
// A resident agent that nobody has talked to for this long is recycled: keeping every past
// session's CLI alive would leak processes on a busy runtime host.
const IDLE_TTL_MS = Number(process.env.ACP_IDLE_TTL_MS || 20 * 60 * 1000);

type ResidentAgent = { client: AcpClient; acpSessionId: string; lastUsed: number };

export interface AcpAdapterOptions {
  id: EngineId;
  displayName: string;
  binary: string;
  args: string[];
  /** Extra env for the child (e.g. an API key); merged over process.env. */
  env?: () => Promise<Record<string, string>>;
  /** Optional extra auth check for probe(); return "" when authenticated. */
  authReason?: () => Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(block: unknown): string {
  if (typeof block === "string") return block;
  if (isRecord(block) && typeof block.text === "string") return block.text;
  return "";
}

/**
 * Adapter for any engine that speaks ACP (Agent Client Protocol).
 *
 * The whole point is **residency**: the CLI is started once per agentd session and reused for
 * every turn, so the multi-second cold start (hermes was ~56s per turn through its one-shot CLI)
 * is paid once. ACP also gives real streaming and tool events, so unlike the one-shot CLI
 * adapters this one can honestly advertise streamingEvents/toolEvents.
 */
export class AcpAdapter implements AgentRuntimeAdapter {
  readonly id: EngineId;
  readonly displayName: string;
  private readonly resident = new Map<string, ResidentAgent>();
  private readonly running = new Map<string, { client: AcpClient; acpSessionId: string }>();

  constructor(private readonly options: AcpAdapterOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
  }

  capabilities(): AgentCapabilities {
    return {
      persistentSessions: true,
      streamingEvents: true,
      toolEvents: true,
      approvals: false,
      steering: false,
      resume: true,
      subagents: false,
      nativeCancellation: true,
      skills: false,
      localWorkspace: true,
    };
  }

  private async resolveExecutable(): Promise<string> {
    const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
      const candidate = path.join(dir, this.options.binary);
      try {
        await fs.access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // keep searching
      }
    }
    throw new Error(`${this.options.binary} CLI 未安装或不在 PATH`);
  }

  async probe(): Promise<{ ok: boolean; detail: Record<string, unknown>; reason: string }> {
    const detail: Record<string, unknown> = { adapter: this.id, transport: "acp", resident: this.resident.size };
    let executablePath = "";
    try {
      executablePath = await this.resolveExecutable();
      detail.installed = true;
      detail.executablePath = executablePath;
    } catch (error) {
      detail.installed = false;
      return { ok: false, detail, reason: errorMessage(error) };
    }
    let authReason = "";
    if (this.options.authReason) {
      try {
        authReason = await this.options.authReason();
      } catch (error) {
        authReason = errorMessage(error);
      }
    }
    detail.authenticated = !authReason;
    return { ok: !authReason, detail, reason: authReason };
  }

  private sweepIdle(): void {
    const now = Date.now();
    for (const [key, agent] of this.resident) {
      if (!agent.client.alive || now - agent.lastUsed > IDLE_TTL_MS) {
        agent.client.kill();
        this.resident.delete(key);
      }
    }
  }

  /** Starts (or reuses) a resident agent for this agentd session and returns its ACP session id. */
  private async acquire(context: AdapterRunContext): Promise<ResidentAgent> {
    this.sweepIdle();
    const { execution } = context;
    const key = execution.sessionRef || execution.id;
    const existing = this.resident.get(key);
    if (existing && existing.client.alive) {
      existing.lastUsed = Date.now();
      return existing;
    }

    const executablePath = await this.resolveExecutable();
    const extraEnv = this.options.env ? await this.options.env() : {};
    const client = new AcpClient(executablePath, this.options.args, {
      cwd: execution.workspace,
      env: { ...process.env, ...extraEnv },
    });

    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });

    let acpSessionId = "";
    // Reconnecting to a session we lost (agentd restart): try loadSession first, fall back to new.
    if (execution.sessionPolicy === "resume" && execution.sessionId) {
      try {
        const loaded = await client.request<any>("session/load", {
          sessionId: execution.sessionId,
          cwd: execution.workspace,
          mcpServers: [],
        });
        acpSessionId = String(loaded?.sessionId || execution.sessionId);
      } catch {
        acpSessionId = "";
      }
    }
    if (!acpSessionId) {
      const created = await client.request<any>("session/new", { cwd: execution.workspace, mcpServers: [] });
      acpSessionId = String(created?.sessionId || "");
      if (!acpSessionId) throw new Error("ACP session/new 未返回 sessionId");
    }

    const agent: ResidentAgent = { client, acpSessionId, lastUsed: Date.now() };
    this.resident.set(key, agent);
    return agent;
  }

  /** 会话创建时提前拉起常驻进程:hermes 冷启动约 60s,预热后第一轮直接进入模型时间。 */
  async warmup(input: { sessionId: string; workspace: string }): Promise<void> {
    this.sweepIdle();
    if (this.resident.get(input.sessionId)?.client.alive) return;
    const executablePath = await this.resolveExecutable();
    const extraEnv = this.options.env ? await this.options.env() : {};
    const client = new AcpClient(executablePath, this.options.args, {
      cwd: input.workspace,
      env: { ...process.env, ...extraEnv },
    });
    try {
      await client.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });
      const created = await client.request<any>("session/new", { cwd: input.workspace, mcpServers: [] });
      const acpSessionId = String(created?.sessionId || "");
      if (!acpSessionId) throw new Error("ACP session/new 未返回 sessionId");
      this.resident.set(input.sessionId, { client, acpSessionId, lastUsed: Date.now() });
    } catch (error) {
      client.kill();
      throw error;
    }
  }

  async run(context: AdapterRunContext): Promise<AdapterRunResult> {
    const { execution } = context;
    const agent = await this.acquire(context);
    const modelSubject = execution.provider?.model ?? this.id;

    let responseText = "";
    let reasoningText = "";
    let emitChain: Promise<unknown> = Promise.resolve();
    const toolStarts = new Map<string, number>();

    const handle = (event: AcpNotification): void => {
      if (event.method !== "session/update") return;
      const update = isRecord(event.params.update) ? event.params.update : {};
      const kind = String(update.sessionUpdate || "");

      if (kind === "agent_message_chunk") {
        const text = textOf(update.content);
        if (!text) return;
        responseText += text;
        emitChain = emitChain.then(() =>
          context.emit({
            type: "model.output.delta",
            status: "running",
            producer: this.id,
            subject: { kind: "model", id: modelSubject },
            summary: `${this.displayName} generated response text`,
            data: { text },
          }),
        );
        return;
      }
      if (kind === "agent_thought_chunk") {
        const text = textOf(update.content);
        if (!text) return;
        reasoningText += text;
        emitChain = emitChain.then(() =>
          context.emit({
            type: "model.reasoning.delta",
            status: "running",
            producer: this.id,
            subject: { kind: "model", id: modelSubject },
            summary: `${this.displayName} generated reasoning text`,
            data: { text },
          }),
        );
        return;
      }
      if (kind === "tool_call" || kind === "tool_call_update") {
        const toolId = String(update.toolCallId || newId("acp-tool"));
        const title = String(update.title || update.kind || "tool");
        const status = String(update.status || "");
        if (kind === "tool_call") toolStarts.set(toolId, Date.now());
        const finished = status === "completed" || status === "failed";
        const startedAt = toolStarts.get(toolId);
        if (finished) toolStarts.delete(toolId);
        emitChain = emitChain.then(() =>
          context.emit({
            type: finished
              ? status === "failed"
                ? "tool.execution.failed"
                : "tool.execution.completed"
              : "tool.execution.started",
            status: "running",
            producer: this.id,
            subject: { kind: "tool", id: title },
            summary: `${title} ${finished ? status : "started"}`,
            data: {
              toolCallId: toolId,
              ...(finished && startedAt ? { durationMs: Date.now() - startedAt } : {}),
            },
          }),
        );
      }
    };
    agent.client.onNotification(handle);

    await context.emit({
      type: "agent.turn.started",
      status: "running",
      producer: this.id,
      subject: { kind: "session", id: agent.acpSessionId },
      summary: `${this.displayName} started processing the Node request (resident ACP)`,
      data: { model: modelSubject, acpSessionId: agent.acpSessionId },
    });

    this.running.set(execution.id, { client: agent.client, acpSessionId: agent.acpSessionId });
    const onAbort = (): void => {
      agent.client.notify("session/cancel", { sessionId: agent.acpSessionId });
    };
    context.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const prompt = `${execution.instruction}\n\nWrite every business output under the output directory: ${execution.outputDir}`;
      const result = await agent.client.request<any>("session/prompt", {
        sessionId: agent.acpSessionId,
        prompt: [{ type: "text", text: prompt }],
      });
      await emitChain;
      const stopReason = String(result?.stopReason || "");
      if (stopReason === "cancelled") throw new Error(`${this.displayName} turn was cancelled`);
      if (!responseText.trim()) {
        throw new Error(`${this.displayName} finished with stopReason=${stopReason || "unknown"} but produced no text`);
      }

      await context.emit({
        type: "agent.turn.settled",
        status: "running",
        producer: this.id,
        subject: { kind: "session", id: agent.acpSessionId },
        summary: `${this.displayName} finished processing the Node request`,
        data: { stopReason },
      });

      let finalReasoning = reasoningText;
      if (finalReasoning.length > REASONING_TEXT_MAX_CHARS) {
        finalReasoning = finalReasoning.slice(-REASONING_TEXT_TRUNCATED_CHARS);
      }
      agent.lastUsed = Date.now();
      return {
        sessionId: agent.acpSessionId,
        nativeRunId: `${agent.acpSessionId}:${execution.id}`,
        responseText: responseText.trim(),
        ...(finalReasoning ? { reasoningText: finalReasoning.trim() } : {}),
      };
    } finally {
      context.signal.removeEventListener("abort", onAbort);
      this.running.delete(execution.id);
      agent.client.onNotification(() => {});
    }
  }

  async cancel(executionId: string): Promise<void> {
    const active = this.running.get(executionId);
    if (active) active.client.notify("session/cancel", { sessionId: active.acpSessionId });
  }
}
