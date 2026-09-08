import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installMcpConnections } from "../src/mcp-install.js";
import { checkInstalledMcpCredentialBinding } from "../src/mcp-credential-binding.js";

test("connection installation is idempotent, preserves old state on invalid input and removes omitted destinations", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-install-")), file = path.join(dir, "bindings.json");
  const binding = { server_id: "records", url: "https://example.test/mcp", headers: { authorization: "vault:service:records#authorization" } };
  try {
    assert.deepEqual(await installMcpConnections({ connections: [binding] }, file), { installed: 1, changed: true });
    const initial = await fs.readFile(file, "utf8"), stat = await fs.stat(file);
    assert.ok(!initial.includes("vault:"));
    assert.deepEqual(await installMcpConnections({ connections: [binding] }, file), { installed: 1, changed: false });
    assert.equal((await fs.stat(file)).mtimeMs, stat.mtimeMs);
    await checkInstalledMcpCredentialBinding(binding, file);
    for (const invalid of [
      { connections: [{ ...binding, headers: { authorization: "plaintext-fixture-secret" } }] },
      { connections: [{ ...binding, url: "https://example.test/mcp?token=fixture" }] },
      { connections: [binding, binding] },
      { connections: [{ ...binding, headers: { Host: "vault:service:records" } }] },
      { connections: [{ ...binding, headers: { authorization: "vault:a", Authorization: "vault:b" } }] },
    ]) {
      await assert.rejects(installMcpConnections(invalid, file), /mcp_/);
      assert.equal(await fs.readFile(file, "utf8"), initial);
    }
    await installMcpConnections({ connections: [] }, file);
    await assert.rejects(checkInstalledMcpCredentialBinding(binding, file), /mcp_credential_binding_not_installed/);
    assert.deepEqual(await fs.readdir(dir), ["bindings.json"]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
