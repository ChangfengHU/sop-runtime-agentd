import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DshWebClient } from "../src/adapters/dsh-adapter.js";

test("DSH 0.1.2 client sends slash endpoint, browser cookie and args.request envelope", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentd-dsh-"));
  const cookieFile = path.join(root, "cookie");
  await writeFile(cookieFile, "dsh-auth-fixture=signed.value\n", { mode: 0o600 });
  const observed: Array<{ url?: string | undefined; cookie?: string | undefined; body?: any }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const entry = { url: request.url, cookie: request.headers.cookie, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
      observed.push(entry);
      const value = entry.body.method === "session/list"
        ? { items: [{ sessionId: "s1", projections: { asOfSeq: 7 } }] }
        : entry.body.method === "session/page"
          ? { records: [], hasMore: false }
          : [{ id: "deepseek-official" }];
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ type: "server-response", rpcId: entry.body.rpcId, result: { ok: true, value } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test address");
    const client = new DshWebClient(`http://127.0.0.1:${address.port}`, cookieFile);
    assert.deepEqual(await client.rpc("llm/listProviders", {}, "args"), [{ id: "deepseek-official" }]);
    await client.page("s1");
    assert.equal(observed[0]?.url, "/api/llm/listProviders");
    assert.equal(observed[0]?.cookie, "dsh-auth-fixture=signed.value");
    assert.equal(observed[0]?.body.type, "client-request");
    assert.equal(observed[0]?.body.method, "llm/listProviders");
    assert.deepEqual(observed[0]?.body.payload, { args: {} });
    assert.equal(typeof observed[0]?.body.rpcId, "string");
    assert.equal(observed[1]?.url, "/api/session/list");
    assert.deepEqual(observed[1]?.body.payload, { args: { _request: {} } });
    assert.equal(observed[2]?.url, "/api/session/page");
    assert.deepEqual(observed[2]?.body.payload, { args: { request: { address: { kind: "session", sessionId: "s1" }, throughSeq: 7, maxMessages: 100 } } });
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("DSH client fails closed for missing cookie and legacy dotted methods", async () => {
  const client = new DshWebClient("http://127.0.0.1:1", "/definitely/missing/dsh-cookie");
  await assert.rejects(client.rpc("session/create", {}), /ENOENT/u);
  await assert.rejects(client.rpc("session.create", {}), /RPC method invalid/u);
});
