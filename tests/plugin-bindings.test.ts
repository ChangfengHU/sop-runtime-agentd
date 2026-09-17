import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server-adapter.js";
import type { AdapterRunContext } from "../src/contracts.js";
import type { McpSession } from "../src/mcp-session.js";
import { pluginBindingRequestSchema } from "../src/plugin-bindings.js";

const sample = { plugin: { id: "sample", repo: "https://github.com/example/plugin", commit: "a".repeat(40), root: ".", skills: [{ id: "one", path: "skills/one" }], mcps: [] }, mcpBindings: [], toolAllowlist: [] };
test("plugin package contracts reject mutable refs, local/SSH repositories and escaping paths", () => {
  assert.ok(pluginBindingRequestSchema.safeParse(sample).success);
  for (const changed of [{ commit: "main" }, { repo: "ssh://github.com/example/plugin" }, { repo: "https://github.com.evil.test/example/plugin" }, { root: "../escape" }, { skills: [{ id: "bad", path: "/tmp/skill" }] }]) {
    assert.equal(pluginBindingRequestSchema.safeParse({ ...sample, plugin: { ...sample.plugin, ...changed } }).success, false);
  }
  assert.equal(pluginBindingRequestSchema.safeParse({ ...sample, mcpBindings: [{ server_id: "one", url: "https://mcp.example/mcp", headers: { Authorization: "Bearer secret" }, tools: [] }] }).success, false);
});

test("dedicated Codex process discovers skills and routes only its selected dynamic tools", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentd-bind-test-"));
  const originalPath = process.env.PATH;
  const adapter = new CodexAppServerAdapter();
  try {
    const bin = path.join(root, "bin"); await fs.mkdir(bin);
    const script = `#!${process.execPath}
import readline from 'node:readline';
import fs from 'node:fs';
if(process.argv.includes('--version')){console.log('codex-cli 0.154.0');process.exit(0)}
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
let roots=[], tools=[], thread='thread-'+process.pid, phase=0;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); const p=m.params||{};
 if(m.method==='initialized')return;
 if(m.method==='initialize'){
   if(!p.capabilities.experimentalApi)throw Error('experimental_missing');
   send({id:m.id,result:{}});
 }else if(m.method==='skills/extraRoots/set'){roots=p.extraRoots;send({id:m.id,result:{}})}
 else if(m.method==='thread/start'){
   tools=p.dynamicTools;
   fs.writeFileSync(process.env.HOME+'/observed.json',JSON.stringify({roots,tools,config:p.config,secret:process.env.SHOULD_NOT_LEAK||null}));
   send({id:m.id,result:{thread:{id:thread}}});
 }else if(m.method==='skills/list')send({id:m.id,result:{data:[{skills:roots.map(p=>({path:p+'/SKILL.md',enabled:true}))}]}});
 else if(m.method==='mcpServerStatus/list')send({id:m.id,result:{data:[],nextCursor:null}});
 else if(m.method==='turn/start'){
   fs.writeFileSync(process.env.HOME+'/prompt.txt',p.input[0].text);
   send({id:m.id,result:{}});
   send({id:9901,method:'item/tool/call',params:{threadId:'another-thread',tool:tools[0].name,arguments:{q:'wrong'}}});
 }else if(m.id===9901){
   if(m.result.success)throw Error('cross_thread_allowed');
   send({id:9902,method:'item/tool/call',params:{threadId:thread,tool:tools[0].name,arguments:{q:'right'}}});
 }else if(m.id===9902){
   if(!m.result.success)throw Error('tool_failed');
   send({method:'item/agentMessage/delta',params:{threadId:thread,delta:m.result.contentItems[0].text}});
   send({method:'turn/completed',params:{threadId:thread,turn:{status:'completed'}}});
 }
});`;
    await fs.writeFile(path.join(bin, "codex"), script, { mode: 0o755 });
    await fs.writeFile(path.join(bin, "package.json"), '{"type":"module"}');
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    process.env.SHOULD_NOT_LEAK = "hidden-value";
    const calls: unknown[] = [];
    for (const id of ["one", "two"]) {
      const home = path.join(root, id); await fs.mkdir(home); await fs.mkdir(path.join(home, "skill"));
      const mcp = { tools: [{ id: `${id}::read`, name: `${id}_read`, description: "read", inputSchema: { type: "object" } }], call: async (tool: string, args: unknown) => { calls.push({ tool, args }); return { text: id }; }, close: async () => {} } as unknown as McpSession;
      await adapter.bindSession({ sessionId: id, workspace: home, home, skills: [path.join(home, "skill/SKILL.md")], mcp, continuation: '[{"user":"old request","assistant":"old response"}]' });
      assert.equal(adapter.bindingAlive(id), true);
      const observed = JSON.parse(await fs.readFile(path.join(home, "observed.json"), "utf8"));
      assert.equal(observed.secret, null);
      assert.deepEqual(observed.tools.map((tool: {name:string}) => tool.name), [`${id}_read`]);
      const context = { execution: { id: `execution-${id}`, sessionRef: id, workspace: home, instruction: "new request", sessionPolicy: "persistent" }, signal: new AbortController().signal, emit: async () => ({}) } as unknown as AdapterRunContext;
      const result = await adapter.run(context);
      assert.match(result.responseText, new RegExp(id));
      assert.match(await fs.readFile(path.join(home, "prompt.txt"), "utf8"), /untrusted prior user\/assistant transcript/);
    }
    assert.deepEqual(calls, [{ tool: "one::read", args: { q: "right" } }, { tool: "two::read", args: { q: "right" } }]);
    await adapter.unbindSession("one");
    assert.equal(adapter.bindingAlive("one"), false);
    assert.equal(adapter.bindingAlive("two"), true);
  } finally {
    await adapter.unbindSession("one"); await adapter.unbindSession("two");
    process.env.PATH = originalPath; delete process.env.SHOULD_NOT_LEAK;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("supervisor rejects busy/implicit history reset and records non-ready bindings honestly", async () => {
  const { SupervisorStore } = await import("../src/store.js");
  const { RuntimeAgentSupervisor } = await import("../src/supervisor.js");
  const { EventHub } = await import("../src/event-hub.js");
  const { ProviderRegistry } = await import("../src/providers.js");
  const { createHttpServer } = await import("../src/http-server.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentd-binding-api-"));
  class NoWarmupCodex extends CodexAppServerAdapter { override async warmup(): Promise<void> {} }
  const adapter = new NoWarmupCodex();
  const store = new SupervisorStore(path.join(root, "db.sqlite"));
  const supervisor = new RuntimeAgentSupervisor({ host: "127.0.0.1", port: 0, dataDir: root, databasePath: path.join(root, "db.sqlite"), credentialDir: root, providerDir: root, maxConcurrent: 1, internalToken: "test-internal-token" }, store, new EventHub(), new ProviderRegistry(root), [adapter]);
  const server = createHttpServer(supervisor);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const { session } = await supervisor.createSession({ engine: "codex", instanceId: "test", workspace: root });
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}/v1/sessions/${session.id}/plugin-bindings`;
    const unauthorized = await fetch(url, { method: "POST", body: JSON.stringify(sample) });
    assert.equal(unauthorized.status, 401);
    const result = await fetch(url, { method: "POST", headers: { authorization: "Bearer test-internal-token", "content-type": "application/json" }, body: JSON.stringify({ ...sample, plugin: { ...sample.plugin, mcps: ["source"] } }) });
    const { binding } = await result.json() as {binding:{status:string;checks:Array<{detail:string}>}};
    assert.equal(binding.status, "not_ready");
    assert.equal(binding.checks.at(-1)?.detail, "plugin_mcp_bindings_missing");
    assert.equal(supervisor.getSession(session.id)?.metadata.plugin_binding, undefined);
    const missing = await fetch(url + "/other", { headers: { authorization: "Bearer test-internal-token" } });
    assert.equal(missing.status, 404);
    session.metadata = { plugin_binding: { status: "ready", pluginId: "sample", commit: "a".repeat(40), sessionId: session.id, checks: [] } }; store.saveSession(session);
    assert.equal(supervisor.getSessionPluginBinding(session.id, "sample")?.status, "not_ready");
    session.turnCount = 2; store.saveSession(session);
    await assert.rejects(supervisor.bindSessionPlugin(session.id, sample), /requires_continuation/);
    await assert.rejects(supervisor.bindSessionPlugin(session.id, { ...sample, allowContinuation: true }), /history_incomplete/);
    session.status = "closed"; store.saveSession(session);
    await assert.rejects(supervisor.bindSessionPlugin(session.id, sample), /session_busy/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("installer preserves full pinned Git tree assets and rejects symbolic links before checkout", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const { installPlugin } = await import("../src/plugin-bindings.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentd-plugin-tree-"));
  const originalPath = process.env.PATH;
  try {
    const repository = path.join(root, "repository"), bin = path.join(root, "bin");
    await fs.mkdir(path.join(repository, ".codex-plugin"), { recursive: true });
    await fs.mkdir(path.join(repository, "skills/one/references"), { recursive: true });
    await fs.mkdir(path.join(repository, "skills/one/assets")); await fs.mkdir(bin);
    await fs.writeFile(path.join(repository, ".codex-plugin/plugin.json"), '{"name":"sample"}');
    await fs.writeFile(path.join(repository, "skills/one/SKILL.md"), "Skill with complete references");
    await fs.writeFile(path.join(repository, "skills/one/references/rules.md"), "Reference rules");
    await fs.writeFile(path.join(repository, "skills/one/assets/image.bin"), Buffer.from([1, 2, 3]));
    const git = async (args: string[]) => exec("/usr/bin/git", args, { cwd: repository });
    await git(["init", "-q"]); await git(["add", "."]);
    await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "initial"]);
    const commit = (await git(["rev-parse", "HEAD"])).stdout.trim();
    // Route this test's otherwise strictly HTTPS GitHub fetch to a local real Git object database.
    await fs.writeFile(path.join(bin, "git"), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const args=process.argv.slice(2).map(a=>a==='protocol.file.allow=never'?'protocol.file.allow=always':a==='https://github.com/example/plugin'?${JSON.stringify(repository)}:a);const r=spawnSync('/usr/bin/git',args,{stdio:'inherit'});process.exit(r.status??1);`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    const result = await installPlugin({ ...sample.plugin, commit }, path.join(root, "installed"));
    assert.equal(await fs.readFile(path.join(result.root, "skills/one/references/rules.md"), "utf8"), "Reference rules");
    assert.deepEqual(await fs.readFile(path.join(result.root, "skills/one/assets/image.bin")), Buffer.from([1, 2, 3]));
    await fs.symlink("/etc/passwd", path.join(repository, "bad-link")); await git(["add", "."]);
    await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "symlink"]);
    const badCommit = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await assert.rejects(installPlugin({ ...sample.plugin, commit: badCommit }, path.join(root, "bad")), /symlink_or_submodule/);
  } finally { process.env.PATH = originalPath; await fs.rm(root, { recursive: true, force: true }); }
});

test("binding settings refuse missing original threads and custom providers without fresh-thread fallback", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentd-strict-resume-"));
  const originalPath = process.env.PATH;
  const adapter = new CodexAppServerAdapter();
  const starts = path.join(root, "starts");
  try {
    await fs.writeFile(path.join(root, "codex"), `#!${process.execPath}
const readline=require('node:readline'),fs=require('node:fs');const send=x=>console.log(JSON.stringify(x));
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')send({id:m.id,result:{}});
else if(m.method==='thread/start'){fs.writeFileSync(${JSON.stringify(starts)},'bad');send({id:m.id,result:{thread:{id:'new'}}})}
else if(m.method==='thread/resume'){
if(m.params.threadId==='missing')send({id:m.id,error:{message:'not found'}});
else send({id:m.id,result:{thread:{id:m.params.threadId},model:'model',modelProvider:'custom-provider',sandbox:{type:'workspaceWrite'}}})}
else if(m.method==='config/read')send({id:m.id,result:{config:{}}});
});`, { mode: 0o755 });
    process.env.PATH = root + path.delimiter + originalPath;
    await assert.rejects(adapter.sessionBindingSettings("s", root, "missing"), /plugin_original_thread_unavailable/);
    await assert.rejects(adapter.sessionBindingSettings("s", root, "custom"), /plugin_model_provider_unsupported/);
    await assert.rejects(fs.access(starts));
  } finally { await adapter.close(); process.env.PATH = originalPath; await fs.rm(root, { recursive: true, force: true }); }
});
