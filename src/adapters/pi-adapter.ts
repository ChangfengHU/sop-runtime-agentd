import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AdapterRunContext,
  AdapterRunResult,
  AgentCapabilities,
  AgentRuntimeAdapter,
} from "../contracts.js";
import { CredentialResolver } from "../credentials.js";
import type { ProviderRegistry } from "../providers.js";
import { errorMessage, SupervisorError } from "../util.js";
import type { PiWorkerInput, PiWorkerMessage } from "./pi-protocol.js";

export interface PiAdapterOptions {
  credentialResolver: CredentialResolver;
  providers: ProviderRegistry;
  dataDir: string;
  agentDir?: string;
}

export class PiAdapter implements AgentRuntimeAdapter {
  readonly id = "sop-native" as const;
  readonly displayName = "SOP Native Agent (Pi)";
  private readonly active = new Map<string, ChildProcess>();

  constructor(private readonly options: PiAdapterOptions) {}

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
      skills: true,
      localWorkspace: true,
    };
  }

  async probe(): Promise<{ ok: boolean; detail: Record<string, unknown>; reason: string }> {
    const workerPath = fileURLToPath(new URL("../workers/pi-worker.js", import.meta.url));
    const detail: Record<string, unknown> = {
      adapter: this.id,
      installed: true,
      workerPath,
      isolatedProcess: true,
      sdk: "@earendil-works/pi-coding-agent",
    };
    const profiles = await this.options.providers.list();
    if (profiles.length === 0) {
      const reason = "没有配置任何 Provider Profile";
      return { ok: false, detail: { ...detail, authenticated: false, note: reason }, reason };
    }
    const first = profiles[0]!;
    detail.defaultModel = first.model;
    const profile = await this.options.providers.get(first.id);
    if (!profile) {
      const reason = `Provider Profile ${first.id} 无法读取`;
      return { ok: false, detail: { ...detail, authenticated: false, note: reason }, reason };
    }
    try {
      // Only resolve to prove the credential is reachable; the value itself is never
      // logged, stored in detail, or returned to the caller.
      await this.options.credentialResolver.resolve(profile.credentialRef);
      return { ok: true, detail: { ...detail, authenticated: true }, reason: "" };
    } catch (error) {
      const reason = `provider profile ${first.id} 的凭据解析失败:${errorMessage(error)}`;
      return { ok: false, detail: { ...detail, authenticated: false, note: reason }, reason };
    }
  }

  async run(context: AdapterRunContext): Promise<AdapterRunResult> {
    const { execution } = context;
    if (!execution.provider) {
      throw new Error("sop-native execution requires a Provider Profile");
    }
    const apiKey = await this.options.credentialResolver.resolve(execution.provider.credentialRef);
    const workerPath = fileURLToPath(new URL("../workers/pi-worker.js", import.meta.url));
    const child = fork(workerPath, [], {
      cwd: execution.workspace,
      env: {
        ...process.env,
        SOP_OUTPUT_DIR: execution.outputDir,
        SOP_AGENTD_MODEL_API_KEY: apiKey,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.active.set(execution.id, child);

    const workerInput: PiWorkerInput = {
      executionId: execution.id,
      workspace: execution.workspace,
      outputDir: execution.outputDir,
      instruction: execution.instruction,
      materials: execution.materials,
      ...(execution.skill ? { skill: execution.skill } : {}),
      provider: execution.provider,
      sessionPolicy: execution.sessionPolicy,
      requestedSessionId: execution.sessionId,
      sessionDir: path.join(this.options.dataDir, "sessions", execution.instanceId),
      agentDir: this.options.agentDir ?? path.join(this.options.dataDir, "pi-agent"),
      // 会话级白名单/写权限:supervisor.createTurn 从 session.metadata 合并进 execution.metadata。
      ...(Array.isArray(execution.metadata?.tool_allowlist) ? { toolAllowlist: (execution.metadata.tool_allowlist as unknown[]).map(String) } : {}),
      ...(typeof execution.metadata?.write_scope === "string" ? { writeScope: execution.metadata.write_scope as string } : {}),
    };

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8_192);
    });
    child.stdout?.resume();

    return await new Promise<AdapterRunResult>((resolve, reject) => {
      let settled = false;
      let emitChain = Promise.resolve();
      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        this.active.delete(execution.id);
        context.signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = (): void => {
        if (child.connected) child.send({ kind: "cancel" });
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 5_000).unref();
      };
      context.signal.addEventListener("abort", onAbort, { once: true });

      child.on("message", (message: PiWorkerMessage) => {
        if (message.kind === "event") {
          emitChain = emitChain.then(async () => {
            await context.emit({
              type: message.type,
              status: "running",
              producer: "pi-agent",
              subject: { kind: message.subjectKind, id: message.subjectId },
              summary: message.summary,
              data: message.data,
            });
          });
        } else if (message.kind === "result") {
          void emitChain.then(() => {
            settle(() => resolve(message));
            child.disconnect();
          });
        } else {
          void emitChain.then(() => settle(() => reject(new Error(message.message))));
        }
      });
      child.once("error", (error) => settle(() => reject(error)));
      child.once("exit", (code, signal) => {
        if (!settled) {
          settle(() =>
            reject(
              new Error(
                `Pi worker exited before returning a result (code=${String(code)}, signal=${String(signal)})${
                  stderr ? `: ${stderr}` : ""
                }`,
              ),
            ),
          );
        }
      });
      child.send(workerInput);
    });
  }

  async cancel(executionId: string): Promise<void> {
    const child = this.active.get(executionId);
    if (child?.connected) {
      child.send({ kind: "cancel" });
    }
  }

  async steer(executionId: string, message: string): Promise<void> {
    const child = this.active.get(executionId);
    if (!child?.connected) {
      throw new SupervisorError(`Execution ${executionId} has no active pi worker to steer`, 409);
    }
    child.send({ kind: "steer", message });
  }
}
