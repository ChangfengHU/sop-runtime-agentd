import { ClaudeCodeAdapter } from "./adapters/claude-code-adapter.js";
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
