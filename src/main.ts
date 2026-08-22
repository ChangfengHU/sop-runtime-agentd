import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ClaudeCodeAdapter } from "./adapters/claude-code-adapter.js";
import { CodexAppServerAdapter } from "./adapters/codex-app-server-adapter.js";
import { AcpAdapter } from "./adapters/acp-adapter.js";
import { DshAdapter } from "./adapters/dsh-adapter.js";
import { OpenclawAdapter } from "./adapters/openclaw-adapter.js";
import { PiAdapter } from "./adapters/pi-adapter.js";
import { loadConfig } from "./config.js";
import { CredentialResolver } from "./credentials.js";
import { EventHub } from "./event-hub.js";
import { createHttpServer } from "./http-server.js";
import { ProviderRegistry } from "./providers.js";
import { SupervisorStore } from "./store.js";
import { RuntimeAgentSupervisor } from "./supervisor.js";
import { ensureDir } from "./util.js";

const config = loadConfig();
await ensureDir(config.dataDir);
await ensureDir(config.credentialDir);
await ensureDir(config.providerDir);
const store = new SupervisorStore(config.databasePath);
const events = new EventHub();
const credentials = new CredentialResolver(config.credentialDir);
const providers = new ProviderRegistry(config.providerDir);
const supervisor = new RuntimeAgentSupervisor(config, store, events, providers, [
  new PiAdapter({ credentialResolver: credentials, providers, dataDir: config.dataDir }),
  new ClaudeCodeAdapter(),
  new CodexAppServerAdapter(),
  // hermes / opencode 走 ACP 常驻:进程按会话复用,冷启动只付一次(hermes 单轮曾 ~56s)
  new AcpAdapter({
    id: "hermes",
    displayName: "Hermes Agent",
    binary: "hermes",
    args: ["acp", "--accept-hooks"],
    authReason: async () => {
      const config = path.join(os.homedir(), ".hermes", "config.yaml");
      try {
        await fsp.access(config);
        return "";
      } catch {
        return "缺少 ~/.hermes/config.yaml(创建 Runtime 时会写入默认 DeepSeek 认证)";
      }
    },
  }),
  new AcpAdapter({
    id: "opencode",
    displayName: "OpenCode",
    binary: "opencode",
    args: ["acp"],
    // 配置里用 {env:SOP_DEEPSEEK_API_KEY} 引用,密钥不落盘到 opencode 的配置文件。
    env: async () => {
      try {
        return { SOP_DEEPSEEK_API_KEY: await credentials.resolve("deepseek.key") };
      } catch {
        return {};
      }
    },
    authReason: async () => {
      // 两种扩展名都认(opencode 实际写的是 .jsonc);只有 $schema 的空壳等于没配 provider。
      for (const name of ["opencode.jsonc", "opencode.json"]) {
        const config = path.join(os.homedir(), ".config", "opencode", name);
        try {
          const text = await fsp.readFile(config, "utf8");
          if (/"provider"\s*:/u.test(text)) return "";
        } catch {
          continue;
        }
      }
      return "未配置模型 provider(~/.config/opencode/opencode.jsonc 里没有 provider 段)";
    },
  }),
  new OpenclawAdapter(),
  new DshAdapter({ credentialResolver: credentials, providers }),
]);
const recovered = supervisor.recover();

// 启动即预热常驻引擎:进程 + 一个预建会话。hermes/opencode 的首轮原本要等
// 30-70s 的进程与 session 初始化,预热后首个真实会话直接认领。
const warmupWorkspace = process.env.SOP_AGENTD_WARMUP_WORKSPACE || `${process.env.HOME}/wiki/runtime-management`;
for (const adapter of supervisor.adapters.values()) {
  const prewarm = (adapter as { prewarm?: (workspace: string) => Promise<void> }).prewarm;
  if (typeof prewarm !== "function") continue;
  void prewarm.call(adapter, warmupWorkspace).catch((error: unknown) => {
    process.stdout.write(`${JSON.stringify({ level: "warn", service: "sop-runtime-agentd", message: `prewarm ${adapter.id} failed`, error: String(error) })}\n`);
  });
}
const server = createHttpServer(supervisor);

server.listen(config.port, config.host, () => {
  process.stdout.write(
    `${JSON.stringify({
      level: "info",
      service: "sop-runtime-agentd",
      message: "Runtime Agent Supervisor listening",
      address: `http://${config.host}:${config.port}`,
      reconciledExecutions: recovered.executions,
      reconciledSessions: recovered.sessions,
    })}\n`,
  );
});

async function shutdown(signal: string): Promise<void> {
  process.stdout.write(`${JSON.stringify({ level: "info", service: "sop-runtime-agentd", message: `Received ${signal}` })}\n`);
  server.close();
  await supervisor.close();
  store.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => process.exit(0));
  });
}
