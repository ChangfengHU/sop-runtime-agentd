import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ClaudeCodeAdapter } from "./adapters/claude-code-adapter.js";
import { CodexAdapter } from "./adapters/codex-adapter.js";
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
  new CodexAdapter(),
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
    authReason: async () => {
      const config = path.join(os.homedir(), ".config", "opencode", "opencode.json");
      try {
        await fsp.access(config);
        return "";
      } catch {
        return "缺少 ~/.config/opencode/opencode.json(需配置模型 provider)";
      }
    },
  }),
  new OpenclawAdapter(),
  new DshAdapter({ credentialResolver: credentials }),
]);
const recovered = supervisor.recover();
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
