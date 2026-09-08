import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fixture } from "./mcp-session.fixture.js";
import { probeMcpConnection } from "../src/mcp-probe.js";
import { installMcpConnections } from "../src/mcp-install.js";
import { checkInstalledMcpCredentialBinding } from "../src/mcp-credential-binding.js";

for (const sse of [false, true]) test(`authenticated catalog ${sse ? "SSE" : "JSON"} uses installed connection and never calls a tool`, async () => {
  const f = await fixture(sse), dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-probe-"));
  const file = path.join(dir, "bindings.json");
  const binding = { server_id: f.binding.server_id, url: "https://fixture.test/mcp", headers: f.binding.headers };
  let lookups = 0;
  const options = {
    authorize: () => checkInstalledMcpCredentialBinding(binding, file),
    resolveCredential: async () => { lookups++; return f.secret; },
    fetch: (async (_url, init) => {
      assert.equal(init?.redirect, "error");
      return fetch(f.binding.url, init);
    }) as typeof fetch,
  };
  try {
    await assert.rejects(probeMcpConnection(binding, AbortSignal.timeout(10000), options), /mcp_credential_binding_unavailable/);
    assert.equal(lookups, 0);assert.equal(f.requests.length, 0);
    await installMcpConnections({ connections: [binding] }, file);
    const result = await probeMcpConnection(binding, AbortSignal.timeout(10000), options);
    assert.deepEqual(result.tools.map(tool => tool.name), ["lookup", "delete"]);
    assert.ok(result.tools.every(tool => /^sha256:/.test(String(tool.schema_digest))));
    assert.ok(!JSON.stringify(result).includes(f.secret));
    assert.equal(f.calls.length, 0);assert.equal(lookups, 1);
    f.exposeSecret();
    await assert.rejects(probeMcpConnection(binding, AbortSignal.timeout(10000), options), /mcp_credential_exposed_in_schema/);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
