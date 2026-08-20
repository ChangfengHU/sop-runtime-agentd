import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AcpClient, type AcpNotification } from "../acp/acp-client.js";
import type { AdapterRunContext, AdapterRunResult, AgentCapabilities, AgentRuntimeAdapter } from "../contracts.js";
import { errorMessage } from "../util.js";

const REASONING_TEXT_MAX_CHARS = 80_000;
const REASONING_TEXT_TRUNCATED_CHARS = 60_000;
const IDLE_TTL_MS = Number(process.env.CODEX_IDLE_TTL_MS || 20 * 60 * 1000);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Codex adapter over the **resident app-server** (`codex app-server`), not one-shot `codex exec`.
 *
 * Protocol captured live on the runtime host (2026-08-20, codex-cli 0.147.0): newline-delimited
 * JSON-RPC on stdio — `initialize` → `thread/start` (result.thread.id) → `turn/start`
 * ({threadId, input:[{type:"text",text}]}), with notifications `item/started`,
 * `item/agentMessage/delta` (real token-level streaming), `item/completed` and `turn/completed`;
 * `turn/interrupt` cancels. Approval callbacks come back as reverse requests and are approved.
 *
 * Why this exists: `codex exec` pays process start + MCP bootstrap on every turn (~10s measured).
 * The app-server pays that once (~3.7s of it is the codex_apps MCP server) and keeps the thread
 * alive, so follow-up turns are close to pure model time.
 */
export class CodexAppServerAdapter implements AgentRuntimeAdapter {
  readonly id = "codex" as const;
  readonly displayName = "Codex CLI";
  private client: AcpClient | null = null;
  private starting: Promise<AcpClient> | null = null;
  private lastUsed = Date.now();
  private readonly threads = new Map<string, string>(); // agentd sessionRef -> codex threadId
  private readonly listeners = new Map<string, (event: AcpNotification) => void>();
  private readonly running = new Map<string, string>(); // executionId -> threadId

  capabilities(): AgentCapabilities {
    return {
      persistentSessions: true,
      streamingEvents: true,
      toolEvents: true,
      approvals: false,
      steering: true,
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
      const candidate = path.join(dir, "codex");
      try {
        await fs.access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // keep searching
      }
    }
    throw new Error("codex CLI 未安装或不在 PATH");
  }

  async probe(): Promise<{ ok: boolean; detail: Record<string, unknown>; reason: string }> {
    const detail: Record<string, unknown> = {
      adapter: this.id,
      transport: "app-server",
      resident: this.client?.alive ? 1 : 0,
      threads: this.threads.size,
    };
    try {
      detail.executablePath = await this.resolveExecutable();
      detail.installed = true;
    } catch (error) {
      detail.installed = false;
      return { ok: false, detail, reason: errorMessage(error) };
    }
    // Auth stays free: a stored login or an API key env var is signal enough.
    let authenticated = Boolean(process.env.OPENAI_API_KEY);
    if (!authenticated) {
      try {
        await fs.access(path.join(os.homedir(), ".codex", "auth.json"), fsConstants.F_OK);
        authenticated = true;
      } catch {
        authenticated = false;
      }
    }
    detail.authenticated = authenticated;
    return {
      ok: authenticated,
      detail,
      reason: authenticated ? "" : "未登录且未配置 OPENAI_API_KEY(在机器上执行 codex 登录一次即可)",
    };
  }

  private async ensureClient(workspace: string): Promise<AcpClient> {
    if (this.client?.alive) {
      this.lastUsed = Date.now();
      return this.client;
    }
    if (this.starting) return await this.starting;
    const boot = (async (): Promise<AcpClient> => {
      const executablePath = await this.resolveExecutable();
      const client = new AcpClient(executablePath, ["app-server"], {
        cwd: workspace,
        env: { ...process.env },
        // Approval callbacks must be answered or the turn hangs; a turn dispatched through agentd
        // was already authorized by its caller.
        onRequest: (method) => (/approval/i.test(method) ? { decision: "approved" } : undefined),
      });
      try {
        await client.request("initialize", {
          clientInfo: { name: "sop-runtime-agentd", version: "0.5.0", title: "SOP Runtime" },
        });
      } catch (error) {
        client.kill();
        throw error;
      }
      client.onNotification((event) => {
        const params = event.params as Record<string, any>;
        const threadId = String(params?.threadId || params?.item?.threadId || "");
        if (threadId) this.listeners.get(threadId)?.(event);
      });
      this.client = client;
      this.lastUsed = Date.now();
      return client;
    })().finally(() => {
      this.starting = null;
    });
    this.starting = boot;
    return await boot;
  }

  private sweepIdle(): void {
    if (this.client && (!this.client.alive || Date.now() - this.lastUsed > IDLE_TTL_MS)) {
      this.client.kill();
      this.client = null;
      this.threads.clear();
      this.listeners.clear();
    }
  }

  private async ensureThread(client: AcpClient, key: string, workspace: string, resumeId: string): Promise<string> {
    const known = this.threads.get(key);
    if (known) return known;
    if (resumeId) {
      try {
        const resumed = await client.request<any>("thread/resume", { threadId: resumeId });
        const id = String(resumed?.thread?.id || resumed?.threadId || resumeId);
        this.threads.set(key, id);
        return id;
      } catch {
        // fall through to a fresh thread
      }
    }
    const started = await client.request<any>("thread/start", { cwd: workspace, sandbox: "workspace-write" });
    const id = String(started?.thread?.id || started?.threadId || "");
    if (!id) throw new Error("codex thread/start 未返回 threadId");
    this.threads.set(key, id);
    return id;
  }

  async warmup(input: { sessionId: string; workspace: string }): Promise<void> {
    this.sweepIdle();
    const client = await this.ensureClient(input.workspace);
    await this.ensureThread(client, input.sessionId, input.workspace, "");
  }

  async run(context: AdapterRunContext): Promise<AdapterRunResult> {
    this.sweepIdle();
    const { execution } = context;
    const key = execution.sessionRef || execution.id;
    const client = await this.ensureClient(execution.workspace);
    const resumeId = execution.sessionPolicy === "resume" ? execution.sessionId || "" : "";
    const threadId = await this.ensureThread(client, key, execution.workspace, resumeId);

    const modelSubject = execution.provider?.model ?? "codex";
    let responseText = "";
    let reasoningText = "";
    let turnError = "";
    let emitChain: Promise<unknown> = Promise.resolve();
    let settleTurn: (() => void) | null = null;
    const finished = new Promise<void>((resolve) => {
      settleTurn = resolve;
    });

    const handle = (event: AcpNotification): void => {
      const params = event.params as Record<string, any>;
      if (event.method === "item/agentMessage/delta") {
        const text = String(params?.delta || params?.text || "");
        if (!text) return;
        responseText += text;
        emitChain = emitChain.then(() =>
          context.emit({
            type: "model.output.delta",
            status: "running",
            producer: "codex",
            subject: { kind: "model", id: modelSubject },
            summary: "Codex generated response text",
            data: { text },
          }),
        );
        return;
      }
      if (event.method === "item/completed" && isRecord(params?.item)) {
        const item = params.item as Record<string, any>;
        const type = String(item.type || "");
        if (type === "agentMessage" && typeof item.text === "string" && item.text) {
          // The completed item carries the whole message; prefer it over accumulated deltas.
          responseText = item.text;
        } else if (type === "reasoning" && typeof item.text === "string" && item.text) {
          reasoningText = reasoningText ? `${reasoningText}\n\n${item.text}` : item.text;
        } else if (type === "commandExecution" || type === "fileChange" || type === "mcpToolCall") {
          const title = String(item.command || item.title || type);
          emitChain = emitChain.then(() =>
            context.emit({
              type: item.status === "failed" ? "tool.execution.failed" : "tool.execution.completed",
              status: "running",
              producer: "codex",
              subject: { kind: "tool", id: title.slice(0, 120) },
              summary: `${title.slice(0, 60)} ${item.status === "failed" ? "failed" : "completed"}`,
              data: { itemType: type, ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}) },
            }),
          );
        }
        return;
      }
      if (event.method === "turn/completed") {
        const turn = isRecord(params?.turn) ? (params.turn as Record<string, any>) : {};
        if (turn.status === "failed" || turn.error) {
          turnError = String(turn.error?.message || turn.error || "codex turn failed");
        }
        settleTurn?.();
        return;
      }
      if (event.method === "turn/failed" || event.method === "error") {
        turnError = String(params?.message || params?.error?.message || "codex reported an error");
        settleTurn?.();
      }
    };

    this.listeners.set(threadId, handle);
    this.running.set(execution.id, threadId);
    const onAbort = (): void => {
      client.notify("turn/interrupt", { threadId });
    };
    context.signal.addEventListener("abort", onAbort, { once: true });

    await context.emit({
      type: "agent.turn.started",
      status: "running",
      producer: "codex",
      subject: { kind: "session", id: threadId },
      summary: "Codex started processing the Node request (resident app-server)",
      data: { model: modelSubject, threadId },
    });

    try {
      const prompt = `${execution.instruction}\n\nWrite every business output under the output directory: ${execution.outputDir}`;
      await client.request("turn/start", { threadId, input: [{ type: "text", text: prompt }] });
      await finished;
      await emitChain;
      if (context.signal.aborted) throw new Error("Codex turn was cancelled");
      if (turnError) throw new Error(turnError);
      if (!responseText.trim()) throw new Error("Codex 完成了这一轮但没有产出文本");

      await context.emit({
        type: "agent.turn.settled",
        status: "running",
        producer: "codex",
        subject: { kind: "session", id: threadId },
        summary: "Codex finished processing the Node request",
        data: {},
      });

      let finalReasoning = reasoningText;
      if (finalReasoning.length > REASONING_TEXT_MAX_CHARS) {
        finalReasoning = finalReasoning.slice(-REASONING_TEXT_TRUNCATED_CHARS);
      }
      this.lastUsed = Date.now();
      return {
        sessionId: threadId,
        nativeRunId: `${threadId}:${execution.id}`,
        responseText: responseText.trim(),
        ...(finalReasoning ? { reasoningText: finalReasoning } : {}),
      };
    } finally {
      context.signal.removeEventListener("abort", onAbort);
      this.listeners.delete(threadId);
      this.running.delete(execution.id);
    }
  }

  async cancel(executionId: string): Promise<void> {
    const threadId = this.running.get(executionId);
    if (threadId && this.client?.alive) this.client.notify("turn/interrupt", { threadId });
  }

  async steer(executionId: string, message: string): Promise<void> {
    const threadId = this.running.get(executionId);
    if (threadId && this.client?.alive) {
      await this.client.request("turn/steer", { threadId, input: [{ type: "text", text: message }] });
    }
  }
}
