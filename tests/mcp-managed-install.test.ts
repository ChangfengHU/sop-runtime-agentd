import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installManagedMcpConnection } from "../src/mcp-managed-install.js";
import { mcpCredentialValue } from "../src/mcp-credential.js";
import { mcpBindingDigest } from "../src/mcp-session.js";

const context = { agent_id: "agent", agent_version: 2, runtime_id: "runtime", capability_binding_id: "capbind-fixture", tool_name: "lookup", schema_digest: `sha256:${"a".repeat(64)}` };
const connection = { server_id: "records", url: "https://records.test/mcp", headers: { Authorization: "vault:service:records#authorization" } };
test("Fleet installation needs an exact immutable-session grant, retains unrelated bindings and merges concurrent installs", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-managed-")), destination = path.join(dir, "bindings.json");
  const signal = AbortSignal.timeout(10000);
  try {
    const old = `sha256:${"b".repeat(64)}`;
    await fs.writeFile(destination, JSON.stringify({ bindings: [old] }));
    for (const grant of [{ ok: true, allowed: true }, { ok: true, allowed: true, capability_binding_id: "another", agent_version: 2 }, { ok: true, allowed: true, capability_binding_id: context.capability_binding_id, agent_version: 1 }, { ok: true, allowed: false }]) {
      await assert.rejects(installManagedMcpConnection({ connection, context }, signal, { destination, fetch: async () => Response.json(grant) }), /mcp_environment_denied/);
      assert.deepEqual(JSON.parse(await fs.readFile(destination, "utf8")), { bindings: [old] });
    }
    const fetcher: typeof fetch = async (url, options) => {
      const query = new URL(String(url)); assert.equal(query.origin, "https://control.vyibc.com"); assert.equal(options?.redirect, "error");
      assert.equal(query.searchParams.get("capability_binding_id"), context.capability_binding_id);
      assert.equal(query.searchParams.get("credential_install"), "1");
      assert.equal(query.searchParams.get("version"), "2"); assert.equal(query.searchParams.get("schema_digest"), context.schema_digest);
      return Response.json({ ok: true, allowed: true, capability_binding_id: context.capability_binding_id, agent_version: 2 });
    };
    const second = { ...connection, server_id: "second", url: "https://second.test/mcp" };
    await Promise.all([connection, second].map(connection => installManagedMcpConnection({ connection, context }, signal, { destination, fetch: fetcher })));
    assert.deepEqual(JSON.parse(await fs.readFile(destination, "utf8")).bindings, [old, mcpBindingDigest(connection), mcpBindingDigest(second)].sort());
    assert.equal((await installManagedMcpConnection({ connection, context }, signal, { destination, fetch: fetcher })).changed, false);
    assert.ok(!(await fs.readFile(destination, "utf8")).includes("vault:"));
    await assert.rejects(installManagedMcpConnection({ connection: { ...connection, headers: { Authorization: "secret" } }, context }, signal, { destination, fetch: fetcher }), /mcp_managed_install_invalid/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test("the existing MCP_TOKEN/token fields provide a Bearer header without copying or changing stored credentials", () => {
  assert.equal(mcpCredentialValue({ MCP_TOKEN: "scoped-fixture" }, "authorization"), "Bearer scoped-fixture");
  assert.equal(mcpCredentialValue({ token: "Bearer scoped-fixture" }, "authorization"), "Bearer scoped-fixture");
  assert.equal(mcpCredentialValue({ authorization: "ApiKey exact", MCP_TOKEN: "other" }, "authorization"), "ApiKey exact");
  assert.equal(mcpCredentialValue({ MCP_TOKEN: "scoped-fixture" }, "MCP_TOKEN"), "scoped-fixture");
  for (const value of [{}, { MCP_TOKEN: "bad\r\nheader" }, { MCP_TOKEN: false }]) assert.throws(() => mcpCredentialValue(value, "authorization"), /mcp_credential_value_invalid/);
});
