import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

test("Pi CLI configurator copies an Agentd provider without replacing unrelated config", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-cli-config-"));
  const providers = path.join(root, "providers"), credentials = path.join(root, "credentials");
  await fs.mkdir(providers); await fs.mkdir(credentials);
  await fs.writeFile(path.join(providers, "aliyun.json"), JSON.stringify({
    id: "aliyun", protocol: "openai-compatible", baseUrl: "https://example.test/v1",
    model: "qwen-plus-latest", credentialRef: "aliyun.key", reasoning: "unsupported",
  }));
  await fs.writeFile(path.join(credentials, "aliyun.key"), "fixture-key\n");
  const agent = path.join(root, ".pi", "agent");
  await fs.mkdir(agent, { recursive: true });
  await fs.writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { existing: { models: [{ id: "kept" }] } } }));
  await fs.writeFile(path.join(agent, "auth.json"), JSON.stringify({ existing: { type: "api_key", key: "kept" } }));
  await fs.writeFile(path.join(agent, "settings.json"), JSON.stringify({ theme: "dark" }));
  const currentUser = os.userInfo().username;
  const result = spawnSync(process.execPath, ["scripts/configure-pi-cli.mjs", "--user", currentUser,
    "--home", root, "--provider-dir", providers, "--credential-dir", credentials], {
    cwd: process.cwd(), env: process.env, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const models = JSON.parse(await fs.readFile(path.join(agent, "models.json"), "utf8"));
  const auth = JSON.parse(await fs.readFile(path.join(agent, "auth.json"), "utf8"));
  const settings = JSON.parse(await fs.readFile(path.join(agent, "settings.json"), "utf8"));
  assert.equal(models.providers.aliyun.models[0].id, "qwen-plus-latest");
  assert.equal(models.providers.aliyun.models[0].reasoning, false);
  assert.equal(JSON.stringify(models).includes("fixture-key"), false);
  assert.deepEqual(auth.aliyun, { type: "api_key", key: "fixture-key" });
  assert.equal(settings.defaultProvider, "aliyun");
  assert.equal(settings.defaultModel, "qwen-plus-latest");
  assert.equal(models.providers.existing.models[0].id, "kept");
  assert.equal(auth.existing.key, "kept");
  assert.equal(settings.theme, "dark");
});
