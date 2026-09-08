import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./mcp-session.fixture.js";

for (const sse of [false, true]) test(`MCP ${sse ? "SSE" : "JSON"} transport pins selected tools, pages catalogs and keeps credentials outside tool results`, async () => {
  const f = await fixture(sse);
  try {
    await f.proxy.prepare([f.binding], ["records::lookup"]);
    assert.deepEqual(f.proxy.tools.map(tool => tool.id), ["records::lookup"]);
    assert.match(f.proxy.tools[0]!.name, /^mcp_[a-f0-9]{40}$/);
    assert.ok(!JSON.stringify(f.proxy.tools).includes(f.secret));
    await assert.rejects(f.proxy.call("records::delete", {}), /mcp_tool_not_allowed/);
    await assert.rejects(f.proxy.call("records::lookup", { extra: "invalid" }), /mcp_tool_arguments_invalid/);
    assert.equal(f.calls.length, 0);
    const result = await f.proxy.call("records::lookup", { key: "one" });
    assert.equal(f.calls.length, 1);
    assert.ok(!JSON.stringify(result).includes("private-fixture-token"));
    assert.ok(JSON.stringify(result).includes("[REDACTED]"));
    f.revoke();
    await assert.rejects(f.proxy.call("records::lookup", { key: "two" }), /mcp_environment_denied/);
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test("changed schemas and upstream failures cannot silently become successful tool calls", async () => {
  const f = await fixture();
  try {
    await f.proxy.prepare([f.binding], ["records::lookup"]);
    f.failTool();
    await assert.rejects(f.proxy.call("records::lookup", { key: "one" }), /mcp_tool_reported_error/);
    f.changeSchema();
    await assert.rejects(f.proxy.call("records::lookup", { key: "two" }), /mcp_tool_schema_changed/);
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test("an interrupted side-effecting MCP call is not automatically retried", async () => {
  const f = await fixture();
  try {
    await f.proxy.prepare([f.binding], ["records::lookup"]);
    f.disconnect();
    await assert.rejects(f.proxy.call("records::lookup", { key: "one" }), /mcp_tool_call_failed/);
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test("startup refuses changed schemas, plaintext credentials and unbound selections", async () => {
  for (const scenario of ["schema", "plaintext", "missing"] as const) {
    const f = await fixture();
    try {
      if (scenario === "schema") f.changeSchema();
      if (scenario === "plaintext") f.binding.headers.authorization = f.secret;
      const allowed = scenario === "missing" ? ["records::not-selected"] : ["records::lookup"];
      await assert.rejects(f.proxy.prepare([f.binding], allowed), /mcp_(tool_schema_changed|bindings_invalid|selected_tool_unbound)/);
      assert.equal(f.calls.length, 0);
    } finally { await f.close(); }
  }
});
