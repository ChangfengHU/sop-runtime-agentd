#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function writeJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, mode);
}

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

const user = argument("--user", process.env.SOP_PI_CLI_USER || "claude");
const providerDir = path.resolve(argument("--provider-dir", process.env.SOP_AGENTD_PROVIDER_DIR || "/etc/sop-runtime-agentd/providers"));
const credentialDir = path.resolve(argument("--credential-dir", process.env.SOP_AGENTD_CREDENTIAL_DIR || "/etc/sop-runtime-agentd/credentials"));
const preferredProvider = argument("--provider", process.env.SOP_PI_CLI_PROVIDER_ID || "aliyun");
const passwd = fs.readFileSync("/etc/passwd", "utf8").split("\n").map(line => line.split(":"));
const account = passwd.find(fields => fields[0] === user);
if (!account) throw new Error(`Pi CLI user does not exist: ${user}`);
const uid = Number(account[2]), gid = Number(account[3]);
const home = path.resolve(argument("--home", account[5] || os.homedir()));

const profiles = fs.readdirSync(providerDir, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
  .map(entry => readJson(path.join(providerDir, entry.name)))
  .filter(profile => profile?.id && profile?.model && profile?.baseUrl && profile?.credentialRef);
const profile = profiles.find(item => item.id === preferredProvider)
  || profiles.find(item => /qwen/i.test(item.model))
  || profiles[0];
if (!profile) throw new Error(`No usable Agentd provider profile found in ${providerDir}`);
if (profile.protocol !== "openai-compatible") throw new Error(`Unsupported Pi CLI provider protocol: ${profile.protocol}`);

const credentialRef = String(profile.credentialRef);
if (credentialRef.startsWith("env:")) throw new Error("Pi CLI bootstrap requires a file-backed credentialRef");
const credentialPath = path.resolve(credentialDir, credentialRef);
if (!credentialPath.startsWith(`${credentialDir}${path.sep}`)) throw new Error("Provider credentialRef escapes credential directory");
const apiKey = fs.readFileSync(credentialPath, "utf8").trim();
if (!apiKey) throw new Error(`Provider credential is empty: ${credentialRef}`);

const agentDir = path.join(home, ".pi", "agent");
const modelsPath = path.join(agentDir, "models.json");
const authPath = path.join(agentDir, "auth.json");
const settingsPath = path.join(agentDir, "settings.json");
const models = readJson(modelsPath, { providers: {} });
models.providers ||= {};
models.providers[profile.id] = {
  baseUrl: profile.baseUrl,
  api: "openai-completions",
  authHeader: true,
  models: [{
    id: profile.model,
    name: profile.model,
    reasoning: profile.reasoning === "streaming" || profile.reasoning === "final",
  }],
};
const auth = readJson(authPath, {});
auth[profile.id] = { type: "api_key", key: apiKey };
const settings = readJson(settingsPath, {});
settings.defaultProvider = profile.id;
settings.defaultModel = profile.model;
settings.enableAnalytics ??= false;

writeJson(modelsPath, models);
writeJson(authPath, auth);
writeJson(settingsPath, settings);
fs.chmodSync(path.join(home, ".pi"), 0o700);
fs.chmodSync(agentDir, 0o700);
if (process.getuid?.() === 0) {
  fs.chownSync(path.join(home, ".pi"), uid, gid);
  fs.chownSync(agentDir, uid, gid);
  for (const file of [modelsPath, authPath, settingsPath]) fs.chownSync(file, uid, gid);
}
console.log(JSON.stringify({ ok: true, user, provider: profile.id, model: profile.model }));
