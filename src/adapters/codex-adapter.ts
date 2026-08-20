import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import type { AdapterRunContext, AdapterRunResult, AgentCapabilities, AgentRuntimeAdapter } from "../contracts.js";
import { errorMessage, newId } from "../util.js";

// Same ledger-bound convention as the pi worker and the Claude Code adapter.
const REASONING_TEXT_MAX_CHARS = 80_000;
const REASONING_TEXT_TRUNCATED_CHARS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function resolveCodexExecutable(): Promise<string> {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, "codex");
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // keep searching the rest of PATH
    }
  }
  throw new Error("codex CLI 未安装或不在 PATH(需完成 codex 登录或配置 OPENAI_API_KEY)");
}

// `codex --version` prints a banner and exits without any model call.
async function readCodexVersion(executablePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executablePath, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("codex --version timed out after 5s"));
    }, 5_000);
    timer.unref();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(stdout.split("\n")[0]?.trim() ?? "");
    });
  });
}

/**
 * Codex CLI adapter.
 *
 * Event source is `codex exec --json`, whose JSONL stream was captured on the runtime host
 * (2026-08-20) and looks like:
 *   {"type":"thread.started","thread_id":"<uuid>"}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{...}}
 * Item types other than agent_message (reasoning, command_execution, file_change, ...) are
 * mapped onto reasoning/tool events; unknown ones are ignored rather than failing the turn.
 *
 * Resume uses `codex exec resume <thread_id> <prompt>` — the thread id doubles as the session id.
 */
export class CodexAdapter implements AgentRuntimeAdapter {
  readonly id = "codex" as const;
  readonly displayName = "Codex CLI";
  private readonly active = new Map<string, ChildProcess>();

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

  async probe(): Promise<{ ok: boolean; detail: Record<string, unknown>; reason: string }> {
    let executablePath = "";
    let installed = true;
    let installError = "";
    try {
      executablePath = await resolveCodexExecutable();
    } catch (error) {
      installed = false;
      installError = errorMessage(error);
    }
    const detail: Record<string, unknown> = { adapter: this.id, installed };
    if (executablePath) detail.executablePath = executablePath;

    if (installed) {
      try {
        const version = await readCodexVersion(executablePath);
        if (version) detail.version = version;
      } catch {
        // Version banner unavailable; the auth check below still decides ok/not-ok.
      }
    }

    // Auth probe stays free: a stored login (~/.codex/auth.json) or an API key env var is
    // signal enough — never burn tokens with a real `codex exec` just to answer "is it logged in".
    const authPath = path.join(os.homedir(), ".codex", "auth.json");
    let hasAuthFile = false;
    try {
      await fs.access(authPath, fsConstants.F_OK);
      hasAuthFile = true;
    } catch {
      hasAuthFile = false;
    }
    const hasApiKeyEnv = Boolean(process.env.OPENAI_API_KEY);
    const authenticated = hasAuthFile || hasApiKeyEnv;
    detail.authenticated = authenticated;

    let reason = "";
    if (!installed) {
      reason = installError;
    } else if (!authenticated) {
      reason = "未登录且未配置 OPENAI_API_KEY(在机器上执行 codex 登录一次即可)";
    }
    return { ok: installed && authenticated, detail, reason };
  }

  async run(context: AdapterRunContext): Promise<AdapterRunResult> {
    const { execution } = context;
    const executablePath = await resolveCodexExecutable();

    let codexSessionId = "";
    const prompt = `${execution.instruction}\n\nWrite every business output under the output directory: ${execution.outputDir}`;
    const isResume = execution.sessionPolicy === "resume";
    if (isResume && !execution.sessionId) {
      throw new Error("codex resume requires an existing native session id on the execution");
    }
    // `codex exec resume` takes its flags BEFORE the session id and rejects --sandbox / -C
    // (verified against codex-cli 0.147.0 --help); the working directory comes from spawn cwd.
    const args = isResume ? ["exec", "resume"] : ["exec"];
    args.push("--json", "--skip-git-repo-check");
    if (!isResume) {
      args.push("--sandbox", "workspace-write", "-C", execution.workspace);
    }
    if (execution.provider?.model) {
      args.push("--model", execution.provider.model);
    }
    if (isResume) {
      codexSessionId = execution.sessionId;
      args.push(codexSessionId);
    }
    args.push(prompt);

    const child = spawn(executablePath, args, {
      cwd: execution.workspace,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.active.set(execution.id, child);

    let stderrTail = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-8_192);
    });

    const modelSubject = execution.provider?.model ?? "codex";
    const toolStarts = new Map<string, { name: string; startedAt: number }>();
    let reasoningText = "";
    let responseText = "";
    let turnFailure = "";

    return await new Promise<AdapterRunResult>((resolve, reject) => {
      let settled = false;
      let emitChain: Promise<unknown> = Promise.resolve();
      const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });

      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        this.active.delete(execution.id);
        context.signal.removeEventListener("abort", onAbort);
        rl.close();
        callback();
      };

      const onAbort = (): void => {
        // exitCode/signalCode are the only reliable "still alive" signals; child.killed just
        // means a signal was sent, which would make the SIGKILL fallback dead code.
        const alive = () => child.exitCode === null && child.signalCode === null;
        if (alive()) child.kill("SIGTERM");
        setTimeout(() => {
          if (alive()) child.kill("SIGKILL");
        }, 5_000).unref();
      };
      context.signal.addEventListener("abort", onAbort, { once: true });

      const emitLater = (event: Parameters<AdapterRunContext["emit"]>[0]): void => {
        emitChain = emitChain.then(async () => {
          await context.emit(event);
        });
      };

      const handleItem = (item: Record<string, unknown>, phase: "started" | "completed"): void => {
        const itemType = typeof item.type === "string" ? item.type : "";
        const itemId = typeof item.id === "string" ? item.id : newId("codex-item");

        if (itemType === "agent_message" && typeof item.text === "string") {
          if (phase !== "completed") return;
          responseText = responseText ? `${responseText}\n${item.text}` : item.text;
          emitLater({
            type: "model.output.delta",
            status: "running",
            producer: "codex",
            subject: { kind: "model", id: modelSubject },
            summary: "Codex generated response text",
            data: { text: item.text },
          });
          return;
        }

        if (itemType === "reasoning") {
          const text = typeof item.text === "string" ? item.text : typeof item.summary === "string" ? item.summary : "";
          if (phase !== "completed" || !text) return;
          reasoningText = reasoningText ? `${reasoningText}\n\n${text}` : text;
          emitLater({
            type: "model.reasoning.delta",
            status: "running",
            producer: "codex",
            subject: { kind: "model", id: modelSubject },
            summary: "Codex generated reasoning text",
            data: { text },
          });
          return;
        }

        // command_execution / file_change / mcp_tool_call / web_search all read as tool activity.
        const toolName =
          (typeof item.command === "string" && item.command.slice(0, 120)) ||
          (typeof item.tool === "string" && item.tool) ||
          itemType ||
          "codex-tool";
        if (phase === "started") {
          toolStarts.set(itemId, { name: toolName, startedAt: Date.now() });
          emitLater({
            type: "tool.execution.started",
            status: "running",
            producer: "codex",
            subject: { kind: "tool", id: toolName },
            summary: `${toolName} started`,
            data: { itemId, itemType },
          });
          return;
        }
        const started = toolStarts.get(itemId);
        toolStarts.delete(itemId);
        const isErr = item.status === "failed" || item.is_error === true;
        const data: Record<string, unknown> = { itemId, itemType, isError: isErr };
        if (started) data.durationMs = Date.now() - started.startedAt;
        if (typeof item.exit_code === "number") data.exitCode = item.exit_code;
        emitLater({
          type: isErr ? "tool.execution.failed" : "tool.execution.completed",
          status: "running",
          producer: "codex",
          subject: { kind: "tool", id: toolName },
          summary: `${toolName} ${isErr ? "failed" : "completed"}`,
          data,
        });
      };

      rl.on("line", (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (!isRecord(parsed)) return;
        const type = typeof parsed.type === "string" ? parsed.type : "";

        if (type === "thread.started") {
          if (typeof parsed.thread_id === "string" && parsed.thread_id) codexSessionId = parsed.thread_id;
          return;
        }

        if (type === "turn.started") {
          emitLater({
            type: "agent.turn.started",
            status: "running",
            producer: "codex",
            subject: { kind: "session", id: codexSessionId || execution.id },
            summary: "Codex started processing the Node request",
            data: { model: modelSubject },
          });
          return;
        }

        if ((type === "item.started" || type === "item.completed" || type === "item.updated") && isRecord(parsed.item)) {
          handleItem(parsed.item, type === "item.started" ? "started" : "completed");
          return;
        }

        if (type === "turn.completed") {
          const usageRaw = isRecord(parsed.usage) ? parsed.usage : {};
          const usage: Record<string, unknown> = {};
          if (typeof usageRaw.input_tokens === "number") usage.inputTokens = usageRaw.input_tokens;
          if (typeof usageRaw.output_tokens === "number") usage.outputTokens = usageRaw.output_tokens;
          if (typeof usageRaw.cached_input_tokens === "number") usage.cacheReadInputTokens = usageRaw.cached_input_tokens;
          emitLater({
            type: "agent.turn.settled",
            status: "running",
            producer: "codex",
            subject: { kind: "session", id: codexSessionId || execution.id },
            summary: "Codex finished processing the Node request",
            data: { usage },
          });
          return;
        }

        if (type === "turn.failed" || type === "error") {
          const errorRecord = isRecord(parsed.error) ? parsed.error : {};
          turnFailure =
            (typeof errorRecord.message === "string" && errorRecord.message) ||
            (typeof parsed.message === "string" && parsed.message) ||
            "Codex reported a turn failure";
          return;
        }
        // Unknown line types are ignored on purpose — new CLI versions add events over time.
      });

      child.once("error", (error) => settle(() => reject(error)));
      child.once("exit", (code, signal) => {
        if (settled) return;
        if (context.signal.aborted) {
          settle(() => reject(new Error("Codex process was cancelled")));
          return;
        }
        if (turnFailure) {
          void emitChain.then(() => settle(() => reject(new Error(turnFailure))));
          return;
        }
        if (code !== 0) {
          const detail = stderrTail ? `: ${stderrTail}` : "";
          settle(() =>
            reject(
              new Error(`Codex process exited with code=${String(code)}, signal=${String(signal)}${detail}`),
            ),
          );
          return;
        }
        if (!responseText) {
          settle(() => reject(new Error("Codex exited successfully but produced no agent message")));
          return;
        }
        let finalReasoning = reasoningText;
        if (finalReasoning.length > REASONING_TEXT_MAX_CHARS) {
          finalReasoning = finalReasoning.slice(-REASONING_TEXT_TRUNCATED_CHARS);
        }
        const result: AdapterRunResult = {
          sessionId: codexSessionId || newId("codex-session"),
          nativeRunId: codexSessionId ? `${codexSessionId}:${execution.id}` : newId("codex-run"),
          responseText,
          ...(finalReasoning ? { reasoningText: finalReasoning } : {}),
        };
        void emitChain.then(() => settle(() => resolve(result)));
      });
    });
  }

  async cancel(executionId: string): Promise<void> {
    const child = this.active.get(executionId);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }
}
