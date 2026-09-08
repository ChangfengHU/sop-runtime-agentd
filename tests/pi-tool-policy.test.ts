import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { PiWorkerInput, PiWorkerMessage } from "../src/adapters/pi-protocol.js";

async function runWorker(input: PiWorkerInput): Promise<PiWorkerMessage[]> {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const child = fork(new URL(`../src/workers/pi-worker.${extension}`, import.meta.url), [], {
    cwd: input.workspace,
    execArgv: extension === "ts" ? ["--import", import.meta.resolve("tsx")] : [],
    env: { ...process.env, SOP_AGENTD_MODEL_API_KEY: "local-test-only", SOP_PI_EXTENSION_PATHS: "" },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const messages: PiWorkerMessage[] = [];
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Pi worker test timed out")); }, 20_000);
      child.on("error", (error) => { clearTimeout(timeout); reject(error); });
      child.on("message", (message) => {
        const event = message as PiWorkerMessage;
        messages.push(event);
        if (event.kind === "result" || event.kind === "error") {
          clearTimeout(timeout);
          child.disconnect();
          resolve(messages);
        }
      });
      child.on("exit", () => {
        clearTimeout(timeout);
        if (messages.some((message) => message.kind === "result" || message.kind === "error")) resolve(messages);
        else reject(new Error(`Pi worker exited without result: ${stderr}`));
      });
      child.send(input);
    });
  } finally {
    child.kill();
  }
}

test("real pi worker exposes only allowed tools and refuses an empty effective set before model dispatch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tool-policy-"));
  const requests: Array<{ tools?: Array<{ function: { name: string } }> }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push(JSON.parse(body));
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const part of [
      { delta: { role: "assistant", content: "ok" }, finish_reason: null },
      { delta: {}, finish_reason: "stop" },
    ]) {
      response.write(`data: ${JSON.stringify({ id: "local-reply", object: "chat.completion.chunk", created: 1, model: "local-test", choices: [{ index: 0, ...part }] })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const input: PiWorkerInput = {
      executionId: "local-policy-test", workspace: root, outputDir: root,
      instruction: "Say ok", materials: [], sessionPolicy: "ephemeral", requestedSessionId: "",
      sessionDir: path.join(root, "sessions"), agentDir: path.join(root, "agent"),
      provider: {
        id: "local-test", protocol: "openai-compatible", provider: "local-test", model: "local-test",
        baseUrl: `http://127.0.0.1:${address.port}/v1`, credentialRef: "env:UNUSED_LOCAL_FIXTURE", options: {},
      },
      toolAllowlist: ["read", "bash"], writeScope: "只读",
    };
    const success = await runWorker(input);
    assert.ok(success.some((message) => message.kind === "result"), JSON.stringify(success));
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]?.tools?.map((tool) => tool.function.name), ["read"]);
    const applied = success.find((message) => message.kind === "event" && message.type === "tools.allowlist.applied");
    assert.ok(applied?.kind === "event");
    assert.deepEqual(applied.data.allowed, ["read"]);
    for (const toolAllowlist of [[], ["not_installed"], ["read", "not_installed"], ["bash"]]) {
      const denied = await runWorker({ ...input, toolAllowlist });
      assert.ok(denied.some((message) => message.kind === "error" && message.message === (toolAllowlist.includes("not_installed") ? "configured_tool_not_available" : "no_allowed_tools_available")), JSON.stringify(denied));
    }
    assert.equal(requests.length, 1, "denied workers must never call the model");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
