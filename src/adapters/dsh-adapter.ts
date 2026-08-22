import type { AdapterRunContext, AdapterRunResult, AgentCapabilities, AgentRuntimeAdapter } from "../contracts.js";
import { errorMessage, newId } from "../util.js";

/**
 * 只有真正需要产物的一轮(绑定了 Skill)才要求引擎写输出目录。
 *
 * 那句指令对 agent 是一条真实任务:实测 dsh 会为它多跑一轮"决定调工具 → 写文件 → 再作答",
 * 单轮 5.2s → 7.5s 并真的产出 answer.txt。纯对话里它纯属浪费。
 */
function outputDirective(execution: { skill?: unknown; outputDir: string }): string {
  return execution.skill ? `\n\nWrite every business output under the output directory: ${execution.outputDir}` : "";
}

/**
 * dsh 常驻 web 服务的地址。服务由 machined 装成机器级 systemd 单元(sop-dsh-web.service),
 * 绑 127.0.0.1;凭据由该单元从 agentd 的凭据目录现读,适配器不再逐轮注入。
 */
const DSH_WEB_URL = (process.env.DSH_WEB_URL || "http://127.0.0.1:3080").replace(/\/+$/u, "");
const DSH_TURN_TIMEOUT_MS = Number(process.env.DSH_TURN_TIMEOUT_MS || 180_000);

/** `POST /api/<method>` 的信封;method 必须与路径末段一致,否则服务端判 bad-request。 */
interface RpcEnvelope {
  type: string;
  rpcId: string;
  result?: { ok: boolean; value?: unknown; error?: { code?: string; message?: string } };
  payload?: Record<string, unknown>;
  method?: string;
}

/** mux 下行帧:服务端单向推送,客户端发任何东西都会被以 1008 关闭。 */
interface MuxFrame {
  type?: string;
  sessionId?: string;
  event?: { type?: string; seq?: number; data?: Record<string, any> };
  approvalId?: string;
  questions?: unknown;
}

type FrameListener = (frame: MuxFrame, rpcId: string) => void;

class DshWebClient {
  private socket: WebSocket | undefined;
  private connecting: Promise<void> | undefined;
  private readonly listeners = new Set<FrameListener>();

  constructor(private readonly baseUrl: string) {}

  async rpc<T = any>(method: string, payload: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: crypto.randomUUID(), method, payload }),
    });
    if (!response.ok) throw new Error(`dsh ${method}: HTTP ${response.status}`);
    const body = (await response.json()) as RpcEnvelope;
    const result = body.result;
    if (!result?.ok) {
      const error = result?.error;
      throw new Error(`dsh ${method}: ${error?.code || "unknown"} ${error?.message || ""}`.trim());
    }
    return result.value as T;
  }

  /** 回复服务端发起的请求(审批/提问):rpcId 必须原样回抄。 */
  async respond(rpcId: string, value: Record<string, unknown>): Promise<void> {
    await fetch(`${this.baseUrl}/api/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-response", rpcId, result: { ok: true, value } }),
    });
  }

  onFrame(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** mux 必须在 prompt 之前连上并保持,否则会漏掉本轮开头的帧。 */
  async ensureSocket(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return;
    if (this.connecting) return await this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const url = `${this.baseUrl.replace(/^http/u, "ws")}/api/events.mux`;
      const socket = new WebSocket(url);
      const settleTimer = setTimeout(() => reject(new Error("dsh mux 连接超时")), 15_000);
      socket.addEventListener("open", () => {
        clearTimeout(settleTimer);
        this.socket = socket;
        resolve();
      });
      socket.addEventListener("error", () => {
        clearTimeout(settleTimer);
        reject(new Error("dsh mux 连接失败"));
      });
      socket.addEventListener("close", () => {
        if (this.socket === socket) this.socket = undefined;
      });
      socket.addEventListener("message", (event: MessageEvent) => {
        let parsed: RpcEnvelope;
        try {
          parsed = JSON.parse(String(event.data)) as RpcEnvelope;
        } catch {
          return;
        }
        const frame = (parsed.payload || {}) as MuxFrame;
        for (const listener of this.listeners) listener(frame, parsed.rpcId);
      });
    }).finally(() => {
      this.connecting = undefined;
    });
    return await this.connecting;
  }
}

/**
 * DeepSeek Harness (dsh) adapter.
 *
 * 走常驻 web 服务的 `/api`(Typert RPC over HTTP + `/api/events.mux` 单向 WS),而不是每轮
 * fork 一个 `dsh --profile headless`。实测理由:headless 每轮都要付进程启动 + Cordis loader
 * 的固定成本,单轮 6.4–8.0s;常驻服务同会话稳态 3.6s(裸模型 2.4–3.2s)。
 *
 * 会话直接用 agentd 自己的 session id 作为 dsh 的 sessionId(dsh 只校验非空,允许预分配),
 * 于是 create 天然幂等:已存在就是 resume。历史由 dsh 自己持久化,不必逐轮重发。
 */
export class DshAdapter implements AgentRuntimeAdapter {
  readonly id = "deepseek-harness" as const;
  readonly displayName = "DeepSeek Harness";
  private readonly client = new DshWebClient(DSH_WEB_URL);
  /** executionId → dsh sessionId,给 cancel 用。 */
  private readonly active = new Map<string, string>();

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
      skills: false,
      localWorkspace: true,
    };
  }

  async probe(): Promise<{ ok: boolean; detail: Record<string, unknown>; reason: string }> {
    const detail: Record<string, unknown> = { adapter: this.id, profile: "web", endpoint: DSH_WEB_URL };
    try {
      const host = await this.client.rpc<Record<string, unknown>>("host.describe", {});
      detail.version = host.version;
      detail.provider = host.provider;
      detail.model = host.model;
      detail.attachedSessions = host.attachedSessions;
      // 服务能答话就说明它已经拿到 provider 凭据(启动时从 agentd 凭据目录读)
      detail.authenticated = Boolean(host.provider);
      if (!host.provider) {
        return { ok: false, detail, reason: "dsh web 服务已起但未解析到模型 provider(检查 DEEPSEEK_API_KEY)" };
      }
      return { ok: true, detail, reason: "" };
    } catch (error) {
      detail.authenticated = false;
      return {
        ok: false,
        detail,
        reason: `dsh 常驻服务不可达(${DSH_WEB_URL},machined 的 sop-dsh-web.service):${errorMessage(error)}`,
      };
    }
  }

  /** 上游网关偶发 502/504,单次失败就判整轮失败太脆;这类瞬时错误退避重试。 */
  private static isTransient(message: string): boolean {
    return /HTTP (429|500|502|503|504)/.test(message) || /timed out|超时|ECONNRESET|mux/i.test(message);
  }

  async run(context: AdapterRunContext): Promise<AdapterRunResult> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.runOnce(context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt >= 1 || context.signal.aborted || !DshAdapter.isTransient(message)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
      }
    }
  }

  private async runOnce(context: AdapterRunContext): Promise<AdapterRunResult> {
    const { execution } = context;
    await this.client.ensureSocket();

    // 用 agentd 的会话 id 当 dsh 的 sessionId:已存在即 resume,不存在即新建,天然幂等。
    const sessionId = execution.sessionId || execution.sessionRef || execution.id;
    await this.client.rpc("session.create", { sessionId, cwd: execution.workspace });
    this.active.set(execution.id, sessionId);

    const modelSubject = execution.provider?.model ?? "deepseek-harness";
    await context.emit({
      type: "agent.turn.started",
      status: "running",
      producer: "deepseek-harness",
      subject: { kind: "session", id: execution.sessionRef || execution.id },
      summary: "DeepSeek Harness started processing the Node request",
      data: { model: modelSubject, profile: "web", nativeSessionId: sessionId },
    });

    const text = execution.instruction + outputDirective(execution);
    try {
      return await this.awaitTurn(context, sessionId, text, modelSubject);
    } finally {
      this.active.delete(execution.id);
    }
  }

  private awaitTurn(
    context: AdapterRunContext,
    sessionId: string,
    prompt: string,
    modelSubject: string,
  ): Promise<AdapterRunResult> {
    const { execution } = context;
    return new Promise<AdapterRunResult>((resolve, reject) => {
      let lastMessage = "";
      let deltas = "";
      let settled = false;
      const pending: Array<Promise<unknown>> = [];

      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stopListening();
        context.signal.removeEventListener("abort", onAbort);
        callback();
      };

      const timer = setTimeout(() => {
        settle(() => reject(new Error(`DeepSeek Harness turn timed out after ${Math.round(DSH_TURN_TIMEOUT_MS / 1000)}s`)));
      }, DSH_TURN_TIMEOUT_MS);
      timer.unref?.();

      const onAbort = (): void => {
        void this.client.rpc("session.cancel", { sessionId }).catch(() => undefined);
        settle(() => reject(new Error("DeepSeek Harness turn was cancelled")));
      };
      context.signal.addEventListener("abort", onAbort, { once: true });

      const stopListening = this.client.onFrame((frame, rpcId) => {
        // 审批会阻塞整轮。headless 时期本来就是无人值守放行,这里保持同一姿态。
        if (frame.type === "approval/requested" && frame.sessionId === sessionId) {
          pending.push(
            this.client.respond(rpcId, {
              sessionId,
              approvalId: String(frame.approvalId || ""),
              outcome: "allowed-once",
            }).catch(() => undefined),
          );
          return;
        }
        if (frame.type === "stream/error") {
          settle(() => reject(new Error(`dsh 下行流错误: ${JSON.stringify((frame as any).error || {}).slice(0, 200)}`)));
          return;
        }
        if (frame.type !== "session/event" || frame.sessionId !== sessionId) return;

        const event = frame.event || {};
        if (event.type === "assistant/chunk" && event.data?.chunk?.type === "text-delta") {
          const chunk = String(event.data.chunk.text ?? "");
          deltas += chunk;
          return;
        }
        if (event.type === "assistant/message") {
          const blocks = (event.data?.message?.content || []) as Array<{ type?: string; text?: string }>;
          const joined = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
          // 规范判定:取本轮最后一条非空 assistant 文本(与 dsh 自身 subagent 的取法一致)
          if (joined.trim()) lastMessage = joined;
          return;
        }
        if (event.type !== "turn/end") return;

        const reason = String(event.data?.reason?.kind || "");
        const responseText = (lastMessage || deltas).trim();
        if (reason !== "completed") {
          settle(() => reject(new Error(`DeepSeek Harness turn ended with reason=${reason || "unknown"}`)));
          return;
        }
        if (!responseText) {
          settle(() => reject(new Error("DeepSeek Harness completed the turn but produced no answer")));
          return;
        }
        const nativeRunId = newId("dsh-run");
        void Promise.allSettled(pending)
          .then(() =>
            context.emit({
              type: "model.output.delta",
              status: "running",
              producer: "deepseek-harness",
              subject: { kind: "model", id: modelSubject },
              summary: "DeepSeek Harness produced the final answer",
              data: { text: responseText },
            }),
          )
          .then(() =>
            context.emit({
              type: "agent.turn.settled",
              status: "running",
              producer: "deepseek-harness",
              subject: { kind: "session", id: sessionId },
              summary: "DeepSeek Harness finished processing the Node request",
              data: {},
            }),
          )
          .then(() => settle(() => resolve({ sessionId, nativeRunId, responseText })));
      });

      this.client
        .rpc("session.prompt", { sessionId, mode: "queue", content: [{ type: "text", text: prompt }] })
        .catch((error) => settle(() => reject(error)));
      void execution;
    });
  }

  async cancel(executionId: string): Promise<void> {
    const sessionId = this.active.get(executionId);
    if (!sessionId) return;
    await this.client.rpc("session.cancel", { sessionId }).catch(() => undefined);
  }
}
