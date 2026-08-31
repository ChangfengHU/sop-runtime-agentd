import assert from "node:assert/strict";
import test from "node:test";

import { applyToolAllowlist } from "../src/tool-allowlist.js";

const HOST = ["read", "bash", "edit", "write", "grep", "find", "ls", "fleet_runtime_list", "fleet_machine_bootstrap"];

test("no allowlist keeps host tools unchanged", () => {
  const result = applyToolAllowlist(HOST, undefined, undefined);
  assert.deepEqual(result.tools, HOST);
  assert.deepEqual(result.removed, []);
});

test("allowlist intersects and reports unknown names", () => {
  const result = applyToolAllowlist(HOST, ["read", "grep", "fleet_runtime_list", "not_a_tool"], "");
  assert.deepEqual(result.tools, ["read", "grep", "fleet_runtime_list"]);
  assert.deepEqual(result.unknown, ["not_a_tool"]);
  assert.ok(result.removed.includes("fleet_machine_bootstrap"));
});

test("read-only write scope strips bash/edit/write even if allowlisted", () => {
  const result = applyToolAllowlist(HOST, ["read", "bash", "write", "ls"], "只读");
  assert.deepEqual(result.tools, ["read", "ls"]);
  assert.deepEqual(result.removed.sort(), ["bash", "edit", "fleet_machine_bootstrap", "fleet_runtime_list", "find", "grep", "write"].sort());
});
