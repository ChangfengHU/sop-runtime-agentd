import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server-adapter.js";
import { RuntimeAgentSupervisor } from "../src/supervisor.js";
import { SupervisorStore } from "../src/store.js";
import { EventHub } from "../src/event-hub.js";
import { ProviderRegistry } from "../src/providers.js";
import { createHttpServer } from "../src/http-server.js";
import { mcpBindingDigest } from "../src/mcp-session.js";
import { fixture } from "./mcp-session.fixture.js";

// Full HTTP + supervisor + Git checkout + child JSON-RPC + MCP protocol. Only remote
// endpoints and the Codex model process are substitutes; no production keys are used.
test("HTTP plugin continuation verifies full package, dynamic MCP calls, schema locks and secret redaction", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-plugin-http-"));
  const mcp = await fixture();
  const originalEnv = { ...process.env }, originalFetch = globalThis.fetch;
  const repository = path.join(root, "repository"), bin = path.join(root, "bin"), workspace = path.join(root, "workspace");
  const exec = promisify(execFile);
  await fs.mkdir(path.join(repository, ".codex-plugin"), { recursive: true });
  await fs.mkdir(path.join(repository, "skills/one/references"), { recursive: true });
  await fs.mkdir(workspace); await fs.mkdir(bin); await fs.mkdir(path.join(root, "source-home"));
  await fs.writeFile(path.join(root, "source-home/auth.json"), '{"fixture":true}');
  await fs.writeFile(path.join(repository, ".codex-plugin/plugin.json"), '{"name":"sample"}');
  await fs.writeFile(path.join(repository, "skills/one/SKILL.md"), '---\nname: one\ndescription: Test\n---\nUse references.');
  await fs.writeFile(path.join(repository, "skills/one/references/full.txt"), "preserved");
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=f@example.invalid", "commit", "-qm", "fixture"]]) await exec("/usr/bin/git", args, { cwd: repository });
  const commit = (await exec("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
  await fs.writeFile(path.join(bin, "git"), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const a=process.argv.slice(2).map(x=>x==='protocol.file.allow=never'?'protocol.file.allow=always':x==='https://github.com/example/plugin.git'?${JSON.stringify(repository)}:x);process.exit(spawnSync('/usr/bin/git',a,{stdio:'inherit'}).status??1);`, { mode: 0o755 });
  await fs.writeFile(path.join(bin, "codex"), `#!${process.execPath}
const readline=require('node:readline'),fs=require('node:fs');
if(process.argv.includes('--version')){console.log('codex-cli 0.154.0');process.exit(0)}
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');let tools=[],roots=[],id='thread-'+process.pid;
const sandbox={type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeTmpdirEnvVar:false,excludeSlashTmp:false};
const settings=()=>({thread:{id},model:'fixture-model',modelProvider:'openai',reasoningEffort:'high',sandbox});
const done=text=>{send({method:'item/agentMessage/delta',params:{threadId:id,delta:text}});send({method:'turn/completed',params:{threadId:id,turn:{status:'completed'}}})};
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line),p=m.params||{};
if(m.method==='initialized')return;
if(m.method==='initialize')send({id:m.id,result:{}});
else if(m.method==='skills/extraRoots/set'){roots=p.extraRoots;send({id:m.id,result:{}})}
else if(m.method==='thread/start'){tools=p.dynamicTools||[];if(tools.length && (p.model!=='fixture-model'||p.config.model_reasoning_effort!=='high'||p.config.sandbox_workspace_write.network_access!==false))throw Error('settings_lost');send({id:m.id,result:settings()})}
else if(m.method==='thread/resume')send({id:m.id,result:settings()});
else if(m.method==='config/read')send({id:m.id,result:{config:{}}});
else if(m.method==='skills/list')send({id:m.id,result:{data:[{skills:roots.map(p=>({name:'one',path:p+'/SKILL.md',enabled:fs.existsSync(p+'/references/full.txt')}))}]}});
else if(m.method==='mcpServerStatus/list')send({id:m.id,result:{data:[],nextCursor:null}});
else if(m.method==='turn/start'){send({id:m.id,result:{}});if(!tools.length){done('prior response');return}fs.appendFileSync(${JSON.stringify(path.join(root, "model-input.jsonl"))},JSON.stringify({tools,prompt:p.input,env:process.env})+'\\n');send({id:9902,method:'item/tool/call',params:{threadId:id,tool:tools[0].name,arguments:{key:'one'}}})}
else if(m.id===9902)done(JSON.stringify(m.result));
});`, { mode: 0o755 });
  const bound = { ...mcp.binding, url: "https://mcp.fixture.test/mcp" };
  await fs.writeFile(path.join(root, "destinations.json"), JSON.stringify({ bindings: [mcpBindingDigest(bound)] }));
  await fs.writeFile(path.join(root, "vault-token"), "fixture-vault-transport-key");
  Object.assign(process.env, { PATH: `${bin}${path.delimiter}${originalEnv.PATH}`, CODEX_HOME: path.join(root, "source-home"), SOP_MCP_CREDENTIAL_BINDINGS_FILE: path.join(root, "destinations.json"), SOP_MCP_VAULT_TOKEN_FILE: path.join(root, "vault-token"), SOP_MCP_VAULT_URL: "https://vault.fixture.test", SOP_MCP_CONTROL_URL: "https://control.fixture.test" });
  let authorizations = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const value = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (value.startsWith("https://control.fixture.test")) { authorizations++; return Response.json({ ok: true, allowed: true }); }
    if (value === "https://vault.fixture.test") return Response.json({ result: { content: [{ type: "text", text: JSON.stringify({ ok: true, value: mcp.secret }) }] } });
    if (value.startsWith("https://mcp.fixture.test")) return originalFetch(mcp.binding.url, init);
    return originalFetch(url, init);
  }) as typeof fetch;
  const adapter = new CodexAppServerAdapter(), store = new SupervisorStore(path.join(root, "db.sqlite"));
  const supervisor = new RuntimeAgentSupervisor({ host: "127.0.0.1", port: 0, dataDir: path.join(root, "data"), databasePath: path.join(root, "db.sqlite"), credentialDir: root, providerDir: root, maxConcurrent: 1, internalToken: "internal-fixture" }, store, new EventHub(), new ProviderRegistry(root), [adapter]);
  const server = createHttpServer(supervisor); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const api = async (route: string, body?: unknown) => { const response = await fetch(base + route, { headers: { authorization: "Bearer internal-fixture", "content-type": "application/json" }, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() as any }; };
  let sessionId = "";
  try {
    const health = await api("/health");
    assert.equal(health.data.adapters.find((entry: {id:string}) => entry.id === "codex").capabilities.pluginBindings, true);
    const created = await api("/v1/sessions", { engine: "codex", workspace, instanceId: "test" });
    sessionId = created.data.session.id;
    for (let n = 0; n < 2; n++) { const turn = await api(`/v1/sessions/${sessionId}/turns?wait=5000`, { instruction: `prior user ${n}` }); assert.equal(turn.data.execution.status, "completed"); }
    const payload = { plugin: { id: "sample", repo: "https://github.com/example/plugin.git", commit, root: ".", skills: [{ id: "one", path: "skills/one" }], mcps: ["records"] }, mcpBindings: [bound], toolAllowlist: ["records::lookup"], agentAccessSnapshot: { agent_id: "reader", agent_version: 1, runtime_id: "runtime" }, allowContinuation: true };
    const installed = await api(`/v1/sessions/${sessionId}/plugin-bindings`, payload);
    assert.equal(installed.status, 200); assert.equal(installed.data.binding.status, "ready", JSON.stringify(installed.data));
    assert.ok(installed.data.binding.checks.some((check: {name:string}) => check.name === "continuation"));
    const repeat = await api(`/v1/sessions/${sessionId}/plugin-bindings`, payload);
    assert.equal(repeat.data.binding.status, "ready");
    const failedReplacement = await api(`/v1/sessions/${sessionId}/plugin-bindings`, { ...payload, plugin: { ...payload.plugin, id: "wrong-manifest" } });
    assert.equal(failedReplacement.data.binding.status, "not_ready");
    assert.equal((await api(`/v1/sessions/${sessionId}/plugin-bindings/sample`)).data.binding.status, "ready");
    const actual = await api(`/v1/sessions/${sessionId}/plugin-bindings/sample`); assert.equal(actual.data.binding.commit, commit);
    const turn = await api(`/v1/sessions/${sessionId}/turns?wait=5000`, { instruction: "/one lookup one" });
    assert.equal(turn.data.execution.status, "completed", turn.data.execution.error); assert.equal(mcp.calls.length, 1);
    const serialized = JSON.stringify({ installed, actual, turn, inputs: await fs.readFile(path.join(root, "model-input.jsonl"), "utf8") });
    assert.ok(!serialized.includes("private-fixture-token")); assert.ok(!serialized.includes("fixture-vault-transport-key"));
    assert.match(serialized, /REDACTED/); assert.match(serialized, /prior user 0/); assert.match(serialized, /prior user 1/);
    assert.ok(serialized.indexOf("prior user 0") < serialized.indexOf("prior user 1"));
    const firstModelInput = JSON.parse((await fs.readFile(path.join(root, "model-input.jsonl"), "utf8")).trim().split("\n")[0]!);
    assert.equal(firstModelInput.prompt[1].type, "skill"); assert.equal(firstModelInput.prompt[1].name, "one");
    assert.ok(authorizations >= 3);
    mcp.changeSchema();
    const refused = await api(`/v1/sessions/${sessionId}/turns?wait=5000`, { instruction: "/unknown lookup again" });
    assert.match(refused.data.execution.responseText, /mcp_tool_schema_changed/); assert.equal(mcp.calls.length, 1);
    const lastModelInput = JSON.parse((await fs.readFile(path.join(root, "model-input.jsonl"), "utf8")).trim().split("\n").at(-1)!);
    assert.equal(lastModelInput.prompt.length, 1); assert.match(lastModelInput.prompt[0].text, /\/unknown lookup again/);
  } finally {
    await adapter.unbindSession(sessionId); await supervisor.close(); store.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    globalThis.fetch = originalFetch; process.env = originalEnv; await mcp.close(); await fs.rm(root, { recursive: true, force: true });
  }
});
