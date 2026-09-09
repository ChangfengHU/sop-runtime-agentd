import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createServer} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {PiAdapter} from '../src/adapters/pi-adapter.js';
import {CredentialResolver} from '../src/credentials.js';
import {EventHub} from '../src/event-hub.js';
import {ProviderRegistry} from '../src/providers.js';
import {SupervisorStore} from '../src/store.js';
import {RuntimeAgentSupervisor} from '../src/supervisor.js';

test('parallel workflow sessions writing the same relative filename produce separate real artifacts',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'workflow-cwd-')),providerDir=path.join(root,'providers');await fs.mkdir(providerDir);
 const model=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=String(chunk);const request=JSON.parse(body);
  const finished=request.messages.some((message:any)=>message.role==='tool');
  const marker=JSON.stringify(request.messages).includes('branch-beta')?'beta':'alpha';
  const delta=finished?{role:'assistant',content:'Wrote the output'}:{role:'assistant',tool_calls:[{index:0,id:'write-one',type:'function',function:{name:'write',arguments:JSON.stringify({path:'analysis.json',content:JSON.stringify({branch:marker})})}}]};
  res.writeHead(200,{'content-type':'text/event-stream'});
  for(const choice of [{delta,finish_reason:null},{delta:{},finish_reason:finished?'stop':'tool_calls'}])res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'local',choices:[{index:0,...choice}]})}\n\n`);
  res.end('data: [DONE]\n\n');
 });
 await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));const address=model.address();assert.ok(address&&typeof address!=='string');
 await fs.writeFile(path.join(providerDir,'local.json'),JSON.stringify({id:'local',protocol:'openai-compatible',provider:'local',model:'local',baseUrl:`http://127.0.0.1:${address.port}/v1`,credentialRef:'env:MODEL_FIXTURE'}));
 const providers=new ProviderRegistry(providerDir),store=new SupervisorStore(path.join(root,'supervisor.db'));
 const adapter=new PiAdapter({dataDir:root,providers,credentialResolver:new CredentialResolver(root,{MODEL_FIXTURE:'local-only'})});
 const supervisor=new RuntimeAgentSupervisor({host:'127.0.0.1',port:0,dataDir:root,databasePath:path.join(root,'supervisor.db'),credentialDir:root,providerDir,maxConcurrent:2,internalToken:''},store,new EventHub(),providers,[adapter]);
 try{
  const started=await Promise.all(['alpha','beta'].map(branch=>supervisor.createSession({instanceId:'pi',engine:'sop-native',providerId:'local',workspace:root,metadata:{workflow_binding:{run_id:'workflow',node_id:branch,attempt:1},tool_allowlist:['write'],skill_bindings:[]},firstInstruction:`Write branch-${branch} to analysis.json`})));
  const done=await Promise.all(started.map(item=>supervisor.waitForTerminal(item.execution!.id,30000)));
  assert.notEqual(done[0]!.execution.outputDir,done[1]!.execution.outputDir);
  for(const [index,item]of done.entries()){
   assert.equal(item.execution.status,'completed',item.execution.error);assert.ok(item.execution.artifacts.some(artifact=>artifact.name==='analysis.json'),JSON.stringify({execution:item.execution,events:supervisor.listEvents(item.execution.id)}));
   assert.deepEqual(JSON.parse(await fs.readFile(path.join(item.execution.outputDir,'analysis.json'),'utf8')),{branch:index?'beta':'alpha'});
   const cwd=supervisor.listEvents(item.execution.id).find(event=>event.type==='execution.cwd.applied');assert.equal((cwd?.data as any).workingDirectory,item.execution.outputDir);
  }
  await assert.rejects(fs.stat(path.join(root,'analysis.json')),{code:'ENOENT'});
 }finally{await supervisor.close();store.close();model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});}
});
