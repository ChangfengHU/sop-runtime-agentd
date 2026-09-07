import type { AdapterRunContext, AdapterRunResult, AgentCapabilities, AgentRuntimeAdapter } from "../contracts.js";
import fsp from "node:fs/promises";
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
const DSH_WEB_COOKIE_FILE = process.env.DSH_WEB_COOKIE_FILE || "/etc/sop-runtime-agentd/credentials/dsh-web.cookie";
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

export class DshWebClient {
  constructor(private readonly baseUrl: string, private readonly cookieFile = DSH_WEB_COOKIE_FILE) {}

  private async cookie(): Promise<string> {
    const value = (await fsp.readFile(this.cookieFile, "utf8")).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+=[A-Za-z0-9._~-]+$/u.test(value) || value.length > 4096) {
      throw new Error("dsh browser-session cookie file is invalid");
    }
    return value;
  }

  async rpc<T = any>(method: string, payload: Record<string, unknown>, shape: "request" | "args" = "request"): Promise<T> {
    if (!/^[a-z][a-zA-Z0-9-]*\/[a-zA-Z0-9-]+$/u.test(method)) throw new Error(`dsh RPC method invalid: ${method}`);
    const response = await fetch(`${this.baseUrl}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await this.cookie() },
      body: JSON.stringify({
        type: "client-request",
        rpcId: crypto.randomUUID(),
        method,
        payload: { args: shape === "request" ? { request: payload } : payload },
      }),
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
      const providers = await this.client.rpc<Array<{ id?: string; name?: string }>>("llm/listProviders", {}, "args");
      detail.providers = providers.map(item => item.id || item.name).filter(Boolean);
      detail.authenticated = providers.length > 0;
      if (!providers.length) {
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

    // 用 agentd 的会话 id 当 dsh 的 sessionId:已存在即 resume,不存在即新建,天然幂等。
    const sessionId = execution.sessionId || execution.sessionRef || execution.id;
    await this.client.rpc("session/create", { sessionId, cwd: execution.workspace });
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

  private async awaitTurn(
    context: AdapterRunContext,
    sessionId: string,
    prompt: string,
    modelSubject: string,
  ): Promise<AdapterRunResult> {
    const { execution } = context;
    const page = await this.client.rpc<{ events?: Array<{ event?: MuxFrame["event"] }> }>("session/page", { address: { kind: "session", sessionId }, maxMessages: 100 });
    const baseline = Math.max(-1, ...(page.events || []).map(entry => Number(entry.event?.seq ?? -1)));
    await this.client.rpc("session/prompt", {
      requestId: execution.id,
      sessionId,
      mode: "queue",
      content: [{ type: "text", text: prompt }],
    });
    const deadline = Date.now() + DSH_TURN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (context.signal.aborted) {
        await this.client.rpc("session/cancel", { sessionId }).catch(() => undefined);
        throw new Error("DeepSeek Harness turn was cancelled");
      }
      await new Promise(resolve => setTimeout(resolve, 1_000));
      const current = await this.client.rpc<{ events?: Array<{ event?: MuxFrame["event"] }> }>("session/page", { address: { kind: "session", sessionId }, maxMessages: 100 });
      const events = (current.events || []).map(entry => entry.event || {}).filter(event => Number(event.seq ?? -1) > baseline);
      let responseText = "";
      for (const event of events) {
        if (event.type === "assistant/message") {
          const blocks = (event.data?.message?.content || []) as Array<{ type?: string; text?: string }>;
          const joined = blocks.filter(block => block.type === "text").map(block => block.text || "").join("").trim();
          if (joined) responseText = joined;
        }
      }
      const ended = [...events].reverse().find(event => event.type === "turn/end");
      if (!ended) continue;
      const reason = String(ended.data?.reason?.kind || "");
      if (reason !== "completed") throw new Error(`DeepSeek Harness turn ended with reason=${reason || "unknown"}`);
      if (!responseText) throw new Error("DeepSeek Harness completed the turn but produced no answer");
      await context.emit({ type: "model.output.delta", status: "running", producer: "deepseek-harness", subject: { kind: "model", id: modelSubject }, summary: "DeepSeek Harness produced the final answer", data: { text: responseText } });
      await context.emit({ type: "agent.turn.settled", status: "running", producer: "deepseek-harness", subject: { kind: "session", id: sessionId }, summary: "DeepSeek Harness finished processing the Node request", data: {} });
      return { sessionId, nativeRunId: newId("dsh-run"), responseText };
    }
    throw new Error(`DeepSeek Harness turn timed out after ${Math.round(DSH_TURN_TIMEOUT_MS / 1000)}s`);
  }

  async cancel(executionId: string): Promise<void> {
    const sessionId = this.active.get(executionId);
    if (!sessionId) return;
    await this.client.rpc("session/cancel", { sessionId }).catch(() => undefined);
  }
}
