import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AdapterRunContext, AdapterRunResult, AgentCapabilities, AgentRuntimeAdapter } from "../contracts.js";
import { errorMessage, newId } from "../util.js";

const REASONING_TEXT_MAX_CHARS = 80_000;
const REASONING_TEXT_TRUNCATED_CHARS = 60_000;

async function resolveHermesExecutable(): Promise<string> {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, "hermes");
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // keep searching the rest of PATH
    }
  }
  throw new Error("hermes CLI 未安装或不在 PATH");
}

async function readHermesVersion(executablePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executablePath, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("hermes --version timed out after 10s"));
    }, 10_000);
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
 * Splits a `hermes chat -Q --pass-session-id --cli --reasoning none` run into answer + session id.
 *
 * Verified on the runtime host (2026-08-20): the final answer goes to **stdout**, the
 * `session_id: <id>` footer goes to **stderr**, and with reasoning disabled stdout carries
 * nothing else. The TUI box stripping below is a fallback for hosts whose config re-enables
 * reasoning rendering (those boxes are not always closed, so anything before the last box
 * marker is dropped rather than trusted).
 */
export function splitHermesOutput(stdout: string, stderr = ""): {
  sessionId: string;
  responseText: string;
  reasoningText: string;
} {
  const sessionMatch = /^\s*session_id:\s*(\S+)\s*$/m;
  const sessionId = (sessionMatch.exec(stderr)?.[1] || sessionMatch.exec(stdout)?.[1] || "").trim();

  const lines = stdout.split("\n").filter((line) => !/^\s*session_id:\s*\S+\s*$/.test(line));
  let lastBoxMarker = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^\s*[┌╭└╰│]/.test(lines[i] ?? "")) {
      lastBoxMarker = i;
      break;
    }
  }
  if (lastBoxMarker === -1) {
    return { sessionId, responseText: lines.join("\n").trim(), reasoningText: "" };
  }
  return {
    sessionId,
    responseText: lines.slice(lastBoxMarker + 1).join("\n").trim(),
    reasoningText: lines.slice(0, lastBoxMarker + 1).join("\n").trim(),
  };
}

/**
 * Hermes Agent adapter.
 *
 * Uses the CLI's non-interactive mode (`hermes chat --query-file <f> -Q --pass-session-id`),
 * which yields the final answer plus a session id, and `--resume <id>` for follow-up turns.
 * Hermes also ships an ACP mode (`hermes acp`) that would give structured streaming/tool
 * events; this adapter deliberately starts with the CLI path and reports
 * streamingEvents/toolEvents as false rather than pretending to have them.
 */
export class HermesAdapter implements AgentRuntimeAdapter {
  readonly id = "hermes" as const;
  readonly displayName = "Hermes Agent";
  private readonly active = new Map<string, ChildProcess>();

  capabilities(): AgentCapabilities {
    return {
      persistentSessions: true,
      streamingEvents: false,
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
    let executablePath = "";
    let installed = true;
    let installError = "";
    try {
      executablePath = await resolveHermesExecutable();
    } catch (error) {
      installed = false;
      installError = errorMessage(error);
    }
    const detail: Record<string, unknown> = { adapter: this.id, installed };
    if (executablePath) detail.executablePath = executablePath;

    if (installed) {
      try {
        const version = await readHermesVersion(executablePath);
        if (version) detail.version = version;
      } catch {
        // Version banner unavailable; config check below still decides ok/not-ok.
      }
    }

    // Hermes authenticates through its own config (model + provider + api key), so the config
    // file is the auth signal — no model call needed.
    const configPath = path.join(os.homedir(), ".hermes", "config.yaml");
    let configured = false;
    try {
      await fs.access(configPath, fsConstants.R_OK);
      configured = true;
    } catch {
      configured = false;
    }
    detail.authenticated = configured;
    if (configured) detail.configPath = configPath;

    let reason = "";
    if (!installed) {
      reason = installError;
    } else if (!configured) {
      reason = "缺少 ~/.hermes/config.yaml(创建 Runtime 时会写入默认 DeepSeek 认证)";
    }
    return { ok: installed && configured, detail, reason };
  }

  async run(context: AdapterRunContext): Promise<AdapterRunResult> {
    const { execution } = context;
    const executablePath = await resolveHermesExecutable();

    // --query-file avoids any shell interpretation of the instruction (quotes, $(), backticks).
    const queryPath = path.join(execution.outputDir, `.hermes-query-${execution.id}.txt`);
    await fs.mkdir(execution.outputDir, { recursive: true });
    await fs.writeFile(
      queryPath,
      `${execution.instruction}\n\nWrite every business output under the output directory: ${execution.outputDir}\n`,
      "utf8",
    );

    // --cli 强制纯文本:在带项目配置的工作目录下 hermes 会渲染 TUI 边框,把答案埋进框里
    // (2026-08-20 在 wiki/runtime-management 下实测复现),--cli 后恢复"推理 + session_id + 答案"。
    // --cli 强制纯文本,--reasoning none 关掉推理渲染:否则 hermes 会往 stdout 打不闭合的
    // TUI 推理框,答案被埋在里面(2026-08-20 在 wiki/runtime-management 下实测)。
    const args = ["chat", "--query-file", queryPath, "-Q", "--pass-session-id", "--cli", "--reasoning", "none"];
    if (execution.sessionPolicy === "resume") {
      if (!execution.sessionId) {
        throw new Error("hermes resume requires an existing native session id on the execution");
      }
      args.push("--resume", execution.sessionId);
    }
    if (execution.provider?.model) {
      args.push("--model", execution.provider.model);
    }

    const child = spawn(executablePath, args, {
      cwd: execution.workspace,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.active.set(execution.id, child);

    const modelSubject = execution.provider?.model ?? "hermes";
    let stdout = "";
    let stderrTail = "";
    // --cli 模式下 hermes 会把答案与 session_id 打到 stderr(2026-08-20 实测),
    // 所以解析必须两条通道都吃;这里限长防止长输出撑爆内存。
    let stderrAll = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-8_192);
      stderrAll = `${stderrAll}${chunk}`.slice(-262_144);
    });

    await context.emit({
      type: "agent.turn.started",
      status: "running",
      producer: "hermes",
      subject: { kind: "session", id: execution.sessionId || execution.id },
      summary: "Hermes started processing the Node request",
      data: { model: modelSubject, resume: execution.sessionPolicy === "resume" },
    });

    return await new Promise<AdapterRunResult>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        this.active.delete(execution.id);
        context.signal.removeEventListener("abort", onAbort);
        void fs.rm(queryPath, { force: true });
        callback();
      };

      const onAbort = (): void => {
        const alive = () => child.exitCode === null && child.signalCode === null;
        if (alive()) child.kill("SIGTERM");
        setTimeout(() => {
          if (alive()) child.kill("SIGKILL");
        }, 5_000).unref();
      };
      context.signal.addEventListener("abort", onAbort, { once: true });

      child.once("error", (error) => settle(() => reject(error)));
      child.once("exit", (code, signal) => {
        if (settled) return;
        if (context.signal.aborted) {
          settle(() => reject(new Error("Hermes process was cancelled")));
          return;
        }
        const parsed = splitHermesOutput(stdout, stderrAll);
        if (code !== 0) {
          const detail = stderrTail ? `: ${stderrTail}` : "";
          settle(() =>
            reject(new Error(`Hermes process exited with code=${String(code)}, signal=${String(signal)}${detail}`)),
          );
          return;
        }
        // Exit code 0 with an empty answer is a known Hermes failure mode (it prints a banner
        // and quits, e.g. on an unreadable skills dir), so treat it as a failure, not success.
        if (!parsed.responseText) {
          const detail = stderrTail ? `: ${stderrTail}` : "";
          settle(() => reject(new Error(`Hermes exited successfully but produced no answer${detail}`)));
          return;
        }

        let finalReasoning = parsed.reasoningText;
        if (finalReasoning.length > REASONING_TEXT_MAX_CHARS) {
          finalReasoning = finalReasoning.slice(-REASONING_TEXT_TRUNCATED_CHARS);
        }
        // 拿不到 hermes 自己的 session id 时绝不能拿 agentd 的 id 冒充:那会被写进台账,
        // 下一轮 --resume 直接撞 "Session not found"。宁可给一个明确的本地 id。
        const sessionId = parsed.sessionId || newId("hermes-session");
        void context
          .emit({
            type: "model.output.delta",
            status: "running",
            producer: "hermes",
            subject: { kind: "model", id: modelSubject },
            summary: "Hermes produced the final answer",
            data: { text: parsed.responseText },
          })
          .then(() =>
            context.emit({
              type: "agent.turn.settled",
              status: "running",
              producer: "hermes",
              subject: { kind: "session", id: sessionId },
              summary: "Hermes finished processing the Node request",
              data: {},
            }),
          )
          .then(() =>
            settle(() =>
              resolve({
                sessionId,
                nativeRunId: `${sessionId}:${execution.id}`,
                responseText: parsed.responseText,
                ...(finalReasoning ? { reasoningText: finalReasoning } : {}),
              }),
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
