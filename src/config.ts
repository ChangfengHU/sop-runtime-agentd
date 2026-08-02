import path from "node:path";

export interface AgentdConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  credentialDir: string;
  providerDir: string;
  maxConcurrent: number;
  internalToken: string;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentdConfig {
  const dataDir = path.resolve(env.SOP_AGENTD_DATA_DIR || "/var/lib/sop-runtime-agentd");
  return {
    host: env.SOP_AGENTD_HOST || "127.0.0.1",
    port: positiveInteger(env.SOP_AGENTD_PORT, 8789),
    dataDir,
    databasePath: path.resolve(env.SOP_AGENTD_DATABASE || path.join(dataDir, "supervisor.db")),
    credentialDir: path.resolve(env.SOP_AGENTD_CREDENTIAL_DIR || "/etc/sop-runtime-agentd/credentials"),
    providerDir: path.resolve(env.SOP_AGENTD_PROVIDER_DIR || "/etc/sop-runtime-agentd/providers"),
    maxConcurrent: positiveInteger(env.SOP_AGENTD_MAX_CONCURRENT, 2),
    internalToken: env.SOP_AGENTD_INTERNAL_TOKEN || "",
  };
}
