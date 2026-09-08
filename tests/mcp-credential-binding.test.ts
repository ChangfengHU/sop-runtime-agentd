import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkInstalledMcpCredentialBinding } from "../src/mcp-credential-binding.js";
import { mcpBindingDigest, type McpBinding } from "../src/mcp-session.js";
import { prepareExecutionMcp } from "../src/mcp-access.js";
import type { ExecutionRecord } from "../src/contracts.js";

const binding: McpBinding = { server_id: "records", url: "https://example.test/mcp", headers: { authorization: "vault:service:example#authorization" }, tools: [{ name: "lookup", schema_digest: `sha256:${"a".repeat(64)}` }] };

test("machine credential binding rejects endpoint/reference changes and observes removal", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-installed-"));
  const file = path.join(dir, "bindings.json");
  try {
    await checkInstalledMcpCredentialBinding({ ...binding, headers: {} }, file);
    await assert.rejects(checkInstalledMcpCredentialBinding(binding, file), /mcp_credential_binding_unavailable/);
    await fs.writeFile(file, JSON.stringify({ bindings: [mcpBindingDigest(binding)] }));
    await checkInstalledMcpCredentialBinding(binding, file);
    for (const changed of [
      { ...binding, url: "https://different.test/mcp" },
      { ...binding, server_id: "other" },
      { ...binding, headers: { authorization: "vault:service:another#authorization" } },
    ]) await assert.rejects(checkInstalledMcpCredentialBinding(changed, file), /mcp_credential_binding_not_installed/);
    await fs.writeFile(file, JSON.stringify({ bindings: [] }));
    await assert.rejects(checkInstalledMcpCredentialBinding(binding, file), /mcp_credential_binding_not_installed/);
    await fs.writeFile(file, '{invalid');
    await assert.rejects(checkInstalledMcpCredentialBinding(binding, file), /mcp_credential_binding_unavailable/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("execution rejects uninstalled credential connections before any network request", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-dispatch-"));
  const previous = process.env.SOP_MCP_CREDENTIAL_BINDINGS_FILE;
  const originalFetch = globalThis.fetch;
  let requests = 0;
  try {
    process.env.SOP_MCP_CREDENTIAL_BINDINGS_FILE = path.join(dir, "missing.json");
    globalThis.fetch = async () => { requests++; throw Error("unexpected_network"); };
    const execution: Pick<ExecutionRecord, "metadata"> = { metadata: { mcp_bindings: [binding], tool_allowlist: ["records::lookup"], agent_access_snapshot: { agent_id: "agent", agent_version: 1, runtime_id: "source" } } };
    await assert.rejects(prepareExecutionMcp(execution, new AbortController().signal), /mcp_credential_binding_unavailable/);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.SOP_MCP_CREDENTIAL_BINDINGS_FILE;
    else process.env.SOP_MCP_CREDENTIAL_BINDINGS_FILE = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
