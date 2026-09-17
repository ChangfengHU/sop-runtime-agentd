import assert from "node:assert/strict";
import test from "node:test";

import { codexReasoningItemText } from "../src/adapters/codex-app-server-adapter.js";
import { dshAssistantContent } from "../src/adapters/dsh-adapter.js";
import { providerProfileSchema } from "../src/contracts.js";

test("Codex reasoning items prefer public summary and accept legacy text", () => {
  assert.equal(codexReasoningItemText({ type: "reasoning", summary: [{ type: "summary_text", text: "first" }, { type: "summary_text", text: "second" }], content: ["raw"] }), "first\nsecond");
  assert.equal(codexReasoningItemText({ type: "reasoning", text: "legacy" }), "legacy");
  assert.equal(codexReasoningItemText({ type: "agentMessage", text: "answer" }), "");
});

test("DSH assistant messages keep reasoning separate from final answer", () => {
  assert.deepEqual(dshAssistantContent([{ type: "reasoning", text: "inspect" }, { type: "text", text: "answer" }, { type: "reasoning", text: " verify" }]), { responseText: "answer", reasoningText: "inspect verify" });
});

test("provider profiles declare reasoning support without guessing from model names", () => {
  const base = { id: "qwen", protocol: "openai-compatible", provider: "aliyun", baseUrl: "https://example.com", model: "qwen-plus", credentialRef: "qwen.key", options: {} } as const;
  assert.equal(providerProfileSchema.parse(base).reasoning, undefined);
  assert.equal(providerProfileSchema.parse({ ...base, reasoning: "streaming" }).reasoning, "streaming");
  assert.throws(() => providerProfileSchema.parse({ ...base, reasoning: "maybe" }));
});
