import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server-adapter.js";
import { executionCommand, prepareExecutionWorkspace, validateInstanceId } from "../src/execution-user.js";
import { createExecutionSchema, type ExecutionRecord } from "../src/contracts.js";
import { SupervisorStore } from "../src/store.js";
import { RuntimeAgentSupervisor } from "../src/supervisor.js";
import { EventHub } from "../src/event-hub.js";
import { ProviderRegistry } from "../src/providers.js";

async function fixture(t: TestContext, scenario: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-connection-"));
  const user = os.userInfo().username;
  const oldPath = process.env.PATH;
  const oldHome = process.env.CODEX_HOME;
  process.env.PATH = `${root}:${oldPath}`;
  process.env.CODEX_HOME = "/wrong-user-home";
  t.after(async () => { process.env.PATH = oldPath; if(oldHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldHome; await fs.rm(root,{recursive:true,force:true}); });
  await fs.writeFile(path.join(root,"codex"), `#!/usr/bin/env node
const fs=require('node:fs');const readline=require('node:readline');
if(process.argv[2]==='login')process.exit(0);
const send=(method,params)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\\n');
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')reply(m.id,{});
 if(m.method==='initialized')fs.writeFileSync(${JSON.stringify(path.join(root,'identity.json'))},JSON.stringify({home:process.env.HOME,user:process.env.USER,codexHome:process.env.CODEX_HOME}));
 if(m.method==='thread/start')reply(m.id,{thread:{id:'fixture-thread'}});
 if(m.method==='turn/start'){
  reply(m.id,{});
  const threadId=m.params.threadId;
  if(${JSON.stringify(scenario)}==='exit')setTimeout(()=>process.exit(1),10);
  else if(${JSON.stringify(scenario)}==='hold'){}
  else {
   send('error',{threadId,error:{message:'Reconnecting... 2/5'},willRetry:true});
   setTimeout(()=>{
    send('item/agentMessage/delta',{threadId,delta:'HARNESS_CONNECTION_OK'});
    send('turn/completed',{threadId,turn:${scenario==='fatal'?"{status:'failed',error:{message:'401 Unauthorized'}}":scenario==='interrupted'?"{status:'interrupted'}":"{status:'completed'}"}});
   },30);
  }
 }
});
`,{mode:0o755});
  const input = createExecutionSchema.parse({ instanceId:"codex",engine:"codex",workspace:root,outputDir:root,instruction:"test",metadata:{execution_user:user} });
  const execution={...input,id:"test",requestId:"test",nodeId:"",sessionRef:"",status:"running",sessionId:"",nativeRunId:"",createdAt:"",startedAt:"",finishedAt:"",error:"",responseText:"",artifacts:[]} as ExecutionRecord;
  const adapter=new CodexAppServerAdapter();const controller=new AbortController();const events:string[]=[];
  const run=()=>adapter.testConnection({execution,history:[],signal:controller.signal,emit:async event=>{events.push(event.type);return {...event,id:0,executionId:"test",occurredAt:""};}});
  return {root,user,run,controller,events};
}

test("recoverable Codex errors do not finish a turn; initialized uses the selected identity",async t=>{
 const f=await fixture(t,"success");const result=await f.run();assert.equal(result.responseText,"HARNESS_CONNECTION_OK");assert.ok(f.events.includes("agent.retrying"));
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root,"identity.json"),"utf8")),{home:os.homedir(),user:f.user});
});
test("final failure reports the 401 instead of an earlier retry",async t=>{const f=await fixture(t,"fatal");await assert.rejects(f.run(),/401 Unauthorized/);});
test("interrupted turns fail even if they produced text",async t=>{const f=await fixture(t,"interrupted");await assert.rejects(f.run(),/turn failed/);});
test("app-server death settles the turn",async t=>{const f=await fixture(t,"exit");await assert.rejects(f.run(),/已退出/);});
test("timeout cancellation settles a held turn",async t=>{const f=await fixture(t,"hold");const timer=setTimeout(()=>f.controller.abort(),100);try{await assert.rejects(f.run(),/cancelled/);}finally{clearTimeout(timer);}});
test("user validation and workspace checks fail before launching a model",async()=>{
 await assert.rejects(executionCommand("root;whoami","codex",[]),/无效/);
 await assert.rejects(prepareExecutionWorkspace({user:os.userInfo().username,workspace:"relative"}),/绝对路径/);
 assert.throws(()=>validateInstanceId("../root"),/无效/);
});
test("saved config persists and chat ignores caller-supplied execution_user",async t=>{
 const f=await fixture(t,"success");const database=path.join(f.root,"agentd.sqlite");let store=new SupervisorStore(database);
 store.saveExecutionConfig("codex",{user:f.user,workspace:f.root});store.close();store=new SupervisorStore(database);
 assert.deepEqual(store.getExecutionConfig("codex"),{user:f.user,workspace:f.root});
 const adapter=new CodexAppServerAdapter();
 const supervisor=new RuntimeAgentSupervisor({host:"127.0.0.1",port:0,dataDir:f.root,databasePath:database,credentialDir:f.root,providerDir:f.root,maxConcurrent:1,internalToken:""},store,new EventHub(),new ProviderRegistry(f.root),[adapter]);
 t.after(async()=>{await supervisor.close();adapter.close();store.close();});
 const {session}=await supervisor.createSession({instanceId:"codex",engine:"codex",workspace:"/root/inaccessible",metadata:{execution_user:"root"}});
 assert.equal(session.workspace,f.root);assert.equal(session.metadata.execution_user,f.user);
 const {execution}=await supervisor.createTurn(session.id,{instruction:"test",metadata:{execution_user:"root"}});
 assert.equal(execution.metadata.execution_user,f.user);
 // A turn follows the saved config even if the caller retained a stale workspace.
 for(let i=0;i<100;i++){if(supervisor.listExecutions()[0]?.status==='completed')break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(supervisor.listExecutions()[0]?.status,"completed");
});
