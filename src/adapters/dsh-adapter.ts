import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { AdapterRunContext, AdapterRunResult, AgentCapabilities, AgentRuntimeAdapter } from "../contracts.js";
import type { CredentialResolver } from "../credentials.js";
import type { ProviderRegistry } from "../providers.js";
import { errorMessage, newId } from "../util.js";

// The headless profile reads its provider key straight from the launching environment
// (dsh error text: "export DEEPSEEK_API_KEY in the launching environment").
const DSH_CREDENTIAL_REF = process.env.DSH_CREDENTIAL_REF || "deepseek.key";
// dsh 默认走 DeepSeek 官方路由;我们的 key 是 api-proxy 签发的,官方接口不认它,
// 必须把 base url 指到同一个 provider profile 上(实测:只加 key 报 invalid,加 base url 才通)。
const DSH_PROVIDER_ID = process.env.DSH_PROVIDER_ID || "deepseek";

async function resolveDshExecutable(): Promise<string> {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, "dsh");
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // keep searching the rest of PATH
    }
  }
  throw new Error("dsh CLI 未安装或不在 PATH(npm i -g @deepseek-ai/dsh)");
}

async function readDshVersion(executablePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executablePath, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("dsh --version timed out after 10s"));
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
 * DeepSeek Harness (dsh) adapter.
 *
 * Uses the `headless` profile — `dsh --profile headless "<task>"` answers one task, prints the
 * final assistant message and exits. That profile has no session/resume/JSON surface (verified
 * against 0.1.0-rc.7 `--profile headless --help`), so persistentSessions/resume are reported
 * false instead of pretending each turn continues a conversation.
 *
 * The provider key comes from agentd's credential store (default ref `deepseek.key`) and is
 * injected into the child environment only — it is never written to disk or logged.
 */
export class DshAdapter implements AgentRuntimeAdapter {
  readonly id = "deepseek-harness" as const;
  readonly displayName = "DeepSeek Harness";
  private readonly active = new Map<string, ChildProcess>();

  constructor(
    private readonly options: { credentialResolver: CredentialResolver; providers: ProviderRegistry },
  ) {}

  /** 从 agentd 的 provider profile 取 base url,避免把网关地址写死在适配器里。 */
  private async resolveBaseUrl(): Promise<string> {
    try {
      const profile = await this.options.providers.get(DSH_PROVIDER_ID);
      return profile?.baseUrl || "";
    } catch {
      return "";
    }
  }

  capabilities(): AgentCapabilities {
    return {
      persistentSessions: false,
      streamingEvents: false,
      toolEvents: false,
      approvals: false,
      steering: false,
      resume: false,
      subagents: false,
      nativeCancellation: true,
      skills: false,
      localWorkspace: true,
    };
  }

  private async resolveApiKey(): Promise<string> {
    return await this.options.credentialResolver.resolve(DSH_CREDENTIAL_REF);
  }

  async probe(): Promise<{ ok: boolean; detail: Record<string, unknown>; reason: string }> {
    let executablePath = "";
    let installed = true;
    let installError = "";
    try {
      executablePath = await resolveDshExecutable();
    } catch (error) {
      installed = false;
      installError = errorMessage(error);
    }
    const detail: Record<string, unknown> = { adapter: this.id, installed, profile: "headless" };
    if (executablePath) detail.executablePath = executablePath;

    if (installed) {
      try {
        const version = await readDshVersion(executablePath);
        if (version) detail.version = version;
      } catch {
        // Version banner unavailable; the credential check below still decides ok/not-ok.
      }
    }

    let authenticated = false;
    let credentialError = "";
    try {
      authenticated = Boolean(await this.resolveApiKey());
    } catch (error) {
      credentialError = errorMessage(error);
    }
    detail.authenticated = authenticated;

    let reason = "";
    if (!installed) {
      reason = installError;
    } else if (!authenticated) {
      reason = `缺少 DeepSeek 凭据(agentd credentials/${DSH_CREDENTIAL_REF}):${credentialError}`;
    }
    return { ok: installed && authenticated, detail, reason };
  }

  async run(context: AdapterRunContext): Promise<AdapterRunResult> {
    const { execution } = context;
    const executablePath = await resolveDshExecutable();
    const apiKey = await this.resolveApiKey();
    const baseUrl = await this.resolveBaseUrl();

    const task = `${execution.instruction}\n\nWrite every business output under the output directory: ${execution.outputDir}`;
    const args = ["--profile", "headless", task];

    const child = spawn(executablePath, args, {
      cwd: execution.workspace,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: apiKey,
        ...(baseUrl ? { DEEPSEEK_BASE_URL: baseUrl } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.active.set(execution.id, child);

    const modelSubject = execution.provider?.model ?? "deepseek-harness";
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
      producer: "deepseek-harness",
      subject: { kind: "session", id: execution.sessionRef || execution.id },
      summary: "DeepSeek Harness started processing the Node request",
      data: { model: modelSubject, profile: "headless" },
    });

    return await new Promise<AdapterRunResult>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        this.active.delete(execution.id);
        context.signal.removeEventListener("abort", onAbort);
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
          settle(() => reject(new Error("DeepSeek Harness process was cancelled")));
          return;
        }
        const responseText = stdout.trim();
        if (code !== 0) {
          const detail = stderrTail ? `: ${stderrTail}` : "";
          settle(() =>
            reject(
              new Error(`DeepSeek Harness process exited with code=${String(code)}, signal=${String(signal)}${detail}`),
            ),
          );
          return;
        }
        if (!responseText) {
          const detail = stderrTail ? `: ${stderrTail}` : "";
          settle(() => reject(new Error(`DeepSeek Harness exited successfully but produced no answer${detail}`)));
          return;
        }
        const sessionId = execution.sessionRef || newId("dsh-session");
        void context
          .emit({
            type: "model.output.delta",
            status: "running",
            producer: "deepseek-harness",
            subject: { kind: "model", id: modelSubject },
            summary: "DeepSeek Harness produced the final answer",
            data: { text: responseText },
          })
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
          .then(() =>
            settle(() =>
              resolve({
                sessionId,
                nativeRunId: newId("dsh-run"),
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
