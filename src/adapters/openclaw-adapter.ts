import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AdapterRunContext, AdapterRunResult, AgentCapabilities, AgentRuntimeAdapter } from "../contracts.js";
import { errorMessage, newId } from "../util.js";

const OPENCLAW_AGENT_ID = process.env.OPENCLAW_AGENT_ID || "main";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function resolveOpenclawExecutable(): Promise<string> {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, "openclaw");
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // keep searching the rest of PATH
    }
  }
  throw new Error("openclaw CLI 未安装或不在 PATH");
}

async function readOpenclawVersion(executablePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executablePath, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("openclaw --version timed out after 10s"));
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
 * Pulls the assistant answer out of `openclaw agent --json` output.
 *
 * Shape captured on the runtime host (2026-08-20): the reply lives at
 * meta.finalAssistantVisibleText (finalAssistantRawText is the same text unstyled), with
 * meta.stopReason / meta.durationMs / meta.executionTrace as run metadata.
 */
export function extractOpenclawAnswer(stdout: string): { responseText: string; meta: Record<string, unknown> } {
  const trimmed = stdout.trim();
  if (!trimmed) return { responseText: "", meta: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON (older CLI or a crash banner) — hand the raw text back so the caller can show it.
    return { responseText: trimmed, meta: {} };
  }
  if (!isRecord(parsed)) return { responseText: trimmed, meta: {} };
  const meta = isRecord(parsed.meta) ? parsed.meta : {};
  const responseText =
    (typeof meta.finalAssistantVisibleText === "string" && meta.finalAssistantVisibleText) ||
    (typeof meta.finalAssistantRawText === "string" && meta.finalAssistantRawText) ||
    "";
  return { responseText: responseText.trim(), meta };
}

/**
 * OpenClaw adapter.
 *
 * Runs `openclaw agent --local --json` (embedded runner, no gateway pairing required) and
 * keys conversations with an explicit `--session-key agent:<id>:<key>` so follow-up turns
 * land in the same OpenClaw session. Streaming/tool events are not exposed by this CLI
 * surface, so those capability bits are reported false rather than faked.
 */
export class OpenclawAdapter implements AgentRuntimeAdapter {
  readonly id = "openclaw" as const;
  readonly displayName = "OpenClaw";
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
      skills: false,
      localWorkspace: true,
    };
  }

  async probe(): Promise<{ ok: boolean; detail: Record<string, unknown>; reason: string }> {
    let executablePath = "";
    let installed = true;
    let installError = "";
    try {
      executablePath = await resolveOpenclawExecutable();
    } catch (error) {
      installed = false;
      installError = errorMessage(error);
    }
    const detail: Record<string, unknown> = { adapter: this.id, installed, agentId: OPENCLAW_AGENT_ID };
    if (executablePath) detail.executablePath = executablePath;

    if (installed) {
      try {
        const version = await readOpenclawVersion(executablePath);
        if (version) detail.version = version;
      } catch {
        // Version banner unavailable; the config check below still decides ok/not-ok.
      }
    }

    // OpenClaw carries its model provider + key in ~/.openclaw/openclaw.json, so that file
    // existing is the auth signal — no model call needed to answer "is it usable".
    const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
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
      reason = "缺少 ~/.openclaw/openclaw.json(创建 Runtime 时会写入默认 DeepSeek 认证)";
    }
    return { ok: installed && configured, detail, reason };
  }

  async run(context: AdapterRunContext): Promise<AdapterRunResult> {
    const { execution } = context;
    const executablePath = await resolveOpenclawExecutable();

    const sessionKey =
      execution.sessionPolicy === "resume" && execution.sessionId
        ? execution.sessionId
        : `agent:${OPENCLAW_AGENT_ID}:${execution.sessionRef || execution.id}`;

    // --message-file keeps the instruction out of argv parsing entirely.
    const messagePath = path.join(execution.outputDir, `.openclaw-message-${execution.id}.txt`);
    await fs.mkdir(execution.outputDir, { recursive: true });
    await fs.writeFile(
      messagePath,
      `${execution.instruction}\n\nWrite every business output under the output directory: ${execution.outputDir}\n`,
      "utf8",
    );

    const args = [
      "agent",
      "--agent",
      OPENCLAW_AGENT_ID,
      // --local runs the embedded agent: no gateway pairing, credentials come from the config.
      "--local",
      "--json",
      "--session-key",
      sessionKey,
      "--message-file",
      messagePath,
    ];
    if (execution.provider?.model) {
      args.push("--model", execution.provider.model);
    }

    const child = spawn(executablePath, args, {
      cwd: execution.workspace,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.active.set(execution.id, child);

    const modelSubject = execution.provider?.model ?? "openclaw";
    let stdout = "";
    let stderrTail = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-8_192);
    });

    await context.emit({
      type: "agent.turn.started",
      status: "running",
      producer: "openclaw",
      subject: { kind: "session", id: sessionKey },
      summary: "OpenClaw started processing the Node request",
      data: { model: modelSubject, sessionKey },
    });

    return await new Promise<AdapterRunResult>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        this.active.delete(execution.id);
        context.signal.removeEventListener("abort", onAbort);
        void fs.rm(messagePath, { force: true });
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
          settle(() => reject(new Error("OpenClaw process was cancelled")));
          return;
        }
        if (code !== 0) {
          const detail = stderrTail ? `: ${stderrTail}` : "";
          settle(() =>
            reject(new Error(`OpenClaw process exited with code=${String(code)}, signal=${String(signal)}${detail}`)),
          );
          return;
        }
        const { responseText, meta } = extractOpenclawAnswer(stdout);
        if (!responseText) {
          const detail = stderrTail ? `: ${stderrTail}` : "";
          settle(() => reject(new Error(`OpenClaw exited successfully but produced no answer${detail}`)));
          return;
        }
        const settleData: Record<string, unknown> = {};
        if (typeof meta.durationMs === "number") settleData.durationMs = meta.durationMs;
        if (typeof meta.stopReason === "string") settleData.stopReason = meta.stopReason;

        void context
          .emit({
            type: "model.output.delta",
            status: "running",
            producer: "openclaw",
            subject: { kind: "model", id: modelSubject },
            summary: "OpenClaw produced the final answer",
            data: { text: responseText },
          })
          .then(() =>
            context.emit({
              type: "agent.turn.settled",
              status: "running",
              producer: "openclaw",
              subject: { kind: "session", id: sessionKey },
              summary: "OpenClaw finished processing the Node request",
              data: settleData,
            }),
          )
          .then(() =>
            settle(() =>
              resolve({
                sessionId: sessionKey,
                nativeRunId: newId("openclaw-run"),
                responseText,
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
