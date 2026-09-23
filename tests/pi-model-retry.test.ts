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

for (const scenario of ['before-tool', 'after-tool', 'permanent-after-tool', 'unauthorized'] as const) {
 test(`real Pi worker handles model failure ${scenario} without duplicating the tool`, {timeout:90000}, async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pi-model-retry-')),providerDir=path.join(root,'providers');await fs.mkdir(providerDir);
  let injected=0;
  const model=createServer(async(req,res)=>{
   let body='';for await(const chunk of req)body+=String(chunk);const request=JSON.parse(body);
   const afterTool=request.messages.some((message:any)=>message.role==='tool');
   const fail=scenario==='unauthorized'||(scenario==='permanent-after-tool'&&afterTool)||(!injected&&(scenario==='before-tool'?!afterTool:afterTool));
   if(fail){injected++;res.writeHead(scenario==='unauthorized'?401:500,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'fixture model serving failure',type:'internal_server_error'}}));return;}
   const delta=afterTool?{role:'assistant',content:'Verified fixture result'}:{role:'assistant',tool_calls:[{index:0,id:'write-receipt',type:'function',function:{name:'write',arguments:JSON.stringify({path:'receipt.json',content:'{"ok":true}'})}}]};
   res.writeHead(200,{'content-type':'text/event-stream'});
   for(const choice of [{delta,finish_reason:null},{delta:{},finish_reason:afterTool?'stop':'tool_calls'}])res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'local',choices:[{index:0,...choice}]})}\n\n`);
   res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));const address=model.address();assert.ok(address&&typeof address!=='string');
  await fs.writeFile(path.join(providerDir,'local.json'),JSON.stringify({id:'local',protocol:'openai-compatible',provider:'local',model:'local',baseUrl:`http://127.0.0.1:${address.port}/v1`,credentialRef:'env:MODEL_FIXTURE'}));
  const providers=new ProviderRegistry(providerDir),store=new SupervisorStore(path.join(root,'supervisor.db'));
  const adapter=new PiAdapter({dataDir:root,providers,credentialResolver:new CredentialResolver(root,{MODEL_FIXTURE:'fixture-only'})});
  const supervisor=new RuntimeAgentSupervisor({host:'127.0.0.1',port:0,dataDir:root,databasePath:path.join(root,'supervisor.db'),credentialDir:root,providerDir,maxConcurrent:1,internalToken:''},store,new EventHub(),providers,[adapter]);
  try{
   const started=await supervisor.createSession({instanceId:'pi',engine:'sop-native',providerId:'local',workspace:root,metadata:{workflow_binding:{run_id:'retry-fixture',node_id:scenario,attempt:1},tool_allowlist:['write'],skill_bindings:[]},firstInstruction:'Write the receipt, then report the actual result'});
   const done=await supervisor.waitForTerminal(started.execution!.id,75000),events=supervisor.listEvents(started.execution!.id);
   assert.ok(injected>0);assert.ok(events.some(e=>e.type==='model.request.failed'),'failure must reach Pi, not be hidden by HTTP client retries');
   assert.equal(events.filter(e=>e.type==='tool.execution.started').length,scenario==='unauthorized'?0:1,'model retry must not replay the tool');
   if(scenario==='before-tool'||scenario==='after-tool'){
    assert.equal(done.execution.status,'completed',done.execution.error);assert.equal(done.execution.error,'');assert.equal(done.execution.responseText,'Verified fixture result');
   }else{assert.equal(done.execution.status,'failed');assert.match(done.execution.error,/fixture model serving failure/);}
  }finally{await supervisor.close();store.close();model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});}
 });
}
