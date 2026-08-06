import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import type { AdapterRunContext, AdapterRunResult, AgentCapabilities, AgentRuntimeAdapter } from "../contracts.js";
import { errorMessage, newId } from "../util.js";

// Same 80000/60000 upper-bound convention used by the pi worker for ledger-bound reasoning
// text: keep the record small even for very long thinking traces.
const REASONING_TEXT_MAX_CHARS = 80_000;
const REASONING_TEXT_TRUNCATED_CHARS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function resolveClaudeExecutable(): Promise<string> {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, "claude");
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // keep searching the rest of PATH
    }
  }
  throw new Error("claude CLI 未安装或不在 PATH(需 ≥2.x 并完成认证)");
}

export class ClaudeCodeAdapter implements AgentRuntimeAdapter {
  readonly id = "claude-code" as const;
  readonly displayName = "Claude Code";
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
    try {
      const executablePath = await resolveClaudeExecutable();
      return { ok: true, detail: { adapter: this.id, executablePath }, reason: "" };
    } catch (error) {
      return { ok: false, detail: { adapter: this.id }, reason: errorMessage(error) };
    }
  }

  async run(context: AdapterRunContext): Promise<AdapterRunResult> {
    const { execution } = context;
    const executablePath = await resolveClaudeExecutable();

    let claudeSessionId: string;
    const args = [
      "-p",
      execution.instruction,
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      // NOTE: spec called for --bare here, but it was verified (2026-08-06, isolated repro with an
      // identical env, only this flag toggled) to break auth on this host: claude exits with
      // "Not logged in · Please run /login" under --bare, and succeeds without it. Deviating from
      // the spec on this one flag; see acceptance report for the repro.
    ];
    if (execution.sessionPolicy === "resume") {
      if (!execution.sessionId) {
        throw new Error("claude-code resume requires an existing native session id on the execution");
      }
      claudeSessionId = execution.sessionId;
      args.push("--resume", claudeSessionId);
    } else {
      claudeSessionId = randomUUID();
      args.push("--session-id", claudeSessionId);
    }
    if (execution.provider?.model) {
      args.push("--model", execution.provider.model);
    }
    args.push(
      "--append-system-prompt",
      `Write every business output under the output directory: ${execution.outputDir}`,
    );

    const child = spawn(executablePath, args, {
      cwd: execution.workspace,
      // The runtime host is a dedicated agentd machine with the same trust posture as the
      // sop-native (pi) engine, so root is expected here; the Claude Code CLI refuses to run
      // as root without this flag.
      env: { ...process.env, IS_SANDBOX: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.active.set(execution.id, child);

    let stderrTail = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-8_192);
    });

    const toolStarts = new Map<string, { name: string; startedAt: number }>();
    const modelSubject = execution.provider?.model ?? "claude-code";
    let reasoningText = "";
    let lastRequestId = "";

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
        // child.killed 只表示"信号已发出"(SIGTERM 发出后即为 true),不能用它判断进程是否
        // 还活着——那会让 SIGKILL 兜底变成死代码;要看 exitCode/signalCode 是否仍为 null。
        const alive = () => child.exitCode === null && child.signalCode === null;
        if (alive()) child.kill("SIGTERM");
        setTimeout(() => {
          if (alive()) child.kill("SIGKILL");
        }, 5_000).unref();
      };
      context.signal.addEventListener("abort", onAbort, { once: true });

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
        if (typeof parsed.request_id === "string" && parsed.request_id) {
          lastRequestId = parsed.request_id;
        }
        const type = typeof parsed.type === "string" ? parsed.type : "";

        if (type === "system" && parsed.subtype === "init") {
          const model = typeof parsed.model === "string" ? parsed.model : "";
          const claudeCodeVersion =
            (typeof parsed.claudeCodeVersion === "string" && parsed.claudeCodeVersion) ||
            (typeof parsed.claude_code_version === "string" && parsed.claude_code_version) ||
            (typeof parsed.version === "string" && parsed.version) ||
            "";
          if (typeof parsed.session_id === "string" && parsed.session_id) {
            claudeSessionId = parsed.session_id;
          }
          emitChain = emitChain.then(async () => {
            await context.emit({
              type: "agent.turn.started",
              status: "running",
              producer: "claude-code",
              subject: { kind: "session", id: claudeSessionId },
              summary: "Claude Code started processing the Node request",
              data: { model, claudeCodeVersion },
            });
          });
          return;
        }

        if (type === "assistant" && isRecord(parsed.message)) {
          const content = Array.isArray(parsed.message.content) ? parsed.message.content : [];
          for (const block of content) {
            if (!isRecord(block)) continue;
            if (block.type === "text" && typeof block.text === "string") {
              const text = block.text;
              emitChain = emitChain.then(async () => {
                await context.emit({
                  type: "model.output.delta",
                  status: "running",
                  producer: "claude-code",
                  subject: { kind: "model", id: modelSubject },
                  summary: "Claude Code generated response text",
                  data: { text },
                });
              });
            } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
              const thinking = block.thinking;
              reasoningText = reasoningText ? `${reasoningText}\n\n${thinking}` : thinking;
              emitChain = emitChain.then(async () => {
                await context.emit({
                  type: "model.reasoning.delta",
                  status: "running",
                  producer: "claude-code",
                  subject: { kind: "model", id: modelSubject },
                  summary: "Claude Code generated reasoning text",
                  data: { text: thinking },
                });
              });
            } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
              const toolUseId = block.id;
              const name = block.name;
              toolStarts.set(toolUseId, { name, startedAt: Date.now() });
              const inputSummary = JSON.stringify(block.input ?? {}).slice(0, 200);
              emitChain = emitChain.then(async () => {
                await context.emit({
                  type: "tool.execution.started",
                  status: "running",
                  producer: "claude-code",
                  subject: { kind: "tool", id: name },
                  summary: `${name} started`,
                  data: { toolUseId, name, input: inputSummary },
                });
              });
            }
          }
          return;
        }

        if (type === "user" && isRecord(parsed.message)) {
          const content = Array.isArray(parsed.message.content) ? parsed.message.content : [];
          for (const block of content) {
            if (!isRecord(block) || block.type !== "tool_result") continue;
            const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
            if (!toolUseId) continue;
            const started = toolStarts.get(toolUseId);
            const name = started?.name ?? "unknown-tool";
            toolStarts.delete(toolUseId);
            const isErr = block.is_error === true;
            const data: Record<string, unknown> = { toolUseId, name, isError: isErr };
            if (started) data.durationMs = Date.now() - started.startedAt;
            emitChain = emitChain.then(async () => {
              await context.emit({
                type: isErr ? "tool.execution.failed" : "tool.execution.completed",
                status: "running",
                producer: "claude-code",
                subject: { kind: "tool", id: name },
                summary: `${name} ${isErr ? "failed" : "completed"}`,
                data,
              });
            });
          }
          return;
        }

        if (type === "result") {
          const isErr = parsed.is_error === true;
          if (isErr) {
            const message =
              (typeof parsed.result === "string" && parsed.result) ||
              `Claude Code reported an error (subtype=${String(parsed.subtype ?? "unknown")})`;
            void emitChain.then(() => settle(() => reject(new Error(message))));
            return;
          }
          const sessionId = (typeof parsed.session_id === "string" && parsed.session_id) || claudeSessionId;
          const nativeRunId =
            (typeof parsed.uuid === "string" && parsed.uuid) || lastRequestId || newId("claude-run");
          const responseText = typeof parsed.result === "string" ? parsed.result : "";

          const settleData: Record<string, unknown> = {};
          if (typeof parsed.num_turns === "number") settleData.numTurns = parsed.num_turns;
          if (typeof parsed.total_cost_usd === "number") settleData.totalCostUsd = parsed.total_cost_usd;
          const usageRaw = isRecord(parsed.usage) ? parsed.usage : {};
          const usage: Record<string, unknown> = {};
          if (typeof usageRaw.input_tokens === "number") usage.inputTokens = usageRaw.input_tokens;
          if (typeof usageRaw.output_tokens === "number") usage.outputTokens = usageRaw.output_tokens;
          if (typeof usageRaw.cache_read_input_tokens === "number") {
            usage.cacheReadInputTokens = usageRaw.cache_read_input_tokens;
          }
          settleData.usage = usage;

          emitChain = emitChain.then(async () => {
            await context.emit({
              type: "agent.turn.settled",
              status: "running",
              producer: "claude-code",
              subject: { kind: "session", id: sessionId },
              summary: "Claude Code finished processing the Node request",
              data: settleData,
            });
          });

          let finalReasoning = reasoningText;
          if (finalReasoning.length > REASONING_TEXT_MAX_CHARS) {
            finalReasoning = finalReasoning.slice(-REASONING_TEXT_TRUNCATED_CHARS);
          }
          const result: AdapterRunResult = {
            sessionId,
            nativeRunId,
            responseText,
            ...(finalReasoning ? { reasoningText: finalReasoning } : {}),
          };
          void emitChain.then(() => settle(() => resolve(result)));
          return;
        }
        // Unknown line types (hook events, rate_limit_event, etc.) are silently ignored.
      });

      child.once("error", (error) => settle(() => reject(error)));
      child.once("exit", (code, signal) => {
        if (settled) return;
        if (context.signal.aborted) {
          settle(() => reject(new Error("Claude Code process was cancelled")));
          return;
        }
        const detail = stderrTail ? `: ${stderrTail}` : "";
        settle(() =>
          reject(
            new Error(
              `Claude Code process exited before returning a result (code=${String(code)}, signal=${String(signal)})${detail}`,
            ),
          ),
        );
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
