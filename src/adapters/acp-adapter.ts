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
/** 每个引擎只常驻一个进程,内部承载多个 ACP 会话——冷启动全局只付一次。 */
type EngineProcess = { client: AcpClient; lastUsed: number };

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
  // 同一会话的启动只做一次:预热尚未完成时来的第一轮必须等它,
  // 否则会并行再起一个进程,冷启动白付两次(实测 hermes 因此仍是 58s)。
  private readonly starting = new Map<string, Promise<ResidentAgent>>();
  private engineProcess: EngineProcess | null = null;
  private engineStarting: Promise<EngineProcess> | null = null;
  // 一个进程承载多个会话,通知必须按 ACP sessionId 分发到对应那一轮
  private readonly listeners = new Map<string, (event: AcpNotification) => void>();
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
        this.listeners.delete(agent.acpSessionId);
        this.resident.delete(key);
      }
    }
    // 进程是所有会话共享的,只有全空闲够久才回收(否则下一个会话又要付冷启动)
    if (this.engineProcess && (!this.engineProcess.client.alive || now - this.engineProcess.lastUsed > IDLE_TTL_MS)) {
      if (this.resident.size === 0) {
        this.engineProcess.client.kill();
        this.engineProcess = null;
      }
    }
  }

  /** 拉起(或复用)该引擎的常驻进程:冷启动只在第一个会话时付一次。 */
  private async ensureEngineProcess(workspace: string): Promise<EngineProcess> {
    if (this.engineProcess?.client.alive) {
      this.engineProcess.lastUsed = Date.now();
      return this.engineProcess;
    }
    if (this.engineStarting) return await this.engineStarting;
    const boot = (async (): Promise<EngineProcess> => {
      const executablePath = await this.resolveExecutable();
      const extraEnv = this.options.env ? await this.options.env() : {};
      const client = new AcpClient(executablePath, this.options.args, {
        cwd: workspace,
        env: { ...process.env, ...extraEnv },
      });
      try {
        await client.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        });
      } catch (error) {
        client.kill();
        throw error;
      }
      // 一个总入口按 sessionId 分发,避免多会话互相覆盖回调
      client.onNotification((event) => {
        const sessionId = String((event.params as any)?.sessionId || "");
        this.listeners.get(sessionId)?.(event);
      });
      const engine: EngineProcess = { client, lastUsed: Date.now() };
      this.engineProcess = engine;
      return engine;
    })().finally(() => {
      this.engineStarting = null;
    });
    this.engineStarting = boot;
    return await boot;
  }

  /** 在常驻进程里开(或恢复)一个 ACP 会话。 */
  private async start(key: string, workspace: string, resumeSessionId = ""): Promise<ResidentAgent> {
    const engine = await this.ensureEngineProcess(workspace);
    const client = engine.client;
    let acpSessionId = "";
    // 重连丢失的会话(agentd 重启过):先试 session/load,不行再开新会话。
    if (resumeSessionId) {
      try {
        const loaded = await client.request<any>("session/load", {
          sessionId: resumeSessionId,
          cwd: workspace,
          mcpServers: [],
        });
        acpSessionId = String(loaded?.sessionId || resumeSessionId);
      } catch {
        acpSessionId = "";
      }
    }
    if (!acpSessionId) {
      const created = await client.request<any>("session/new", { cwd: workspace, mcpServers: [] });
      acpSessionId = String(created?.sessionId || "");
      if (!acpSessionId) throw new Error("ACP session/new 未返回 sessionId");
    }
    const agent: ResidentAgent = { client, acpSessionId, lastUsed: Date.now() };
    this.resident.set(key, agent);
    engine.lastUsed = Date.now();
    return agent;
  }

  /** 取得该会话的常驻 agent:已在跑就复用,正在启动就等它,都没有才新建。 */
  private async acquire(context: AdapterRunContext): Promise<ResidentAgent> {
    this.sweepIdle();
    const { execution } = context;
    const key = execution.sessionRef || execution.id;
    const existing = this.resident.get(key);
    if (existing && existing.client.alive) {
      existing.lastUsed = Date.now();
      return existing;
    }
    const inflight = this.starting.get(key);
    if (inflight) return await inflight;
    const resumeId = execution.sessionPolicy === "resume" ? execution.sessionId || "" : "";
    const pending = this.start(key, execution.workspace, resumeId).finally(() => this.starting.delete(key));
    this.starting.set(key, pending);
    return await pending;
  }

  /** 会话创建时提前拉起常驻进程:hermes 冷启动约 60s,预热后第一轮直接进入模型时间。 */
  async warmup(input: { sessionId: string; workspace: string }): Promise<void> {
    this.sweepIdle();
    if (this.resident.get(input.sessionId)?.client.alive) return;
    if (this.starting.has(input.sessionId)) return;
    const pending = this.start(input.sessionId, input.workspace).finally(() =>
      this.starting.delete(input.sessionId),
    );
    this.starting.set(input.sessionId, pending);
    await pending;
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
    this.listeners.set(agent.acpSessionId, handle);

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
      // 有的 agent(实测 opencode)把 agent_message 通知排在 session/prompt 响应之后:
      // 响应一回来就判定会得到"无文本",而那段文本会迟到并被算进下一轮(实测下一轮返回 "42 142")。
      // 因此文本为空时给一个收尾窗口,等通知落地再判。
      if (!responseText.trim()) {
        const deadline = Date.now() + 10_000;
        while (!responseText.trim() && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        await emitChain;
      }
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
      this.listeners.delete(agent.acpSessionId);
    }
  }

  async cancel(executionId: string): Promise<void> {
    const active = this.running.get(executionId);
    if (active) active.client.notify("session/cancel", { sessionId: active.acpSessionId });
  }
}
