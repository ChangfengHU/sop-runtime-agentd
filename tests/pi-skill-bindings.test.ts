import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PiAdapter } from "../src/adapters/pi-adapter.js";
import { CredentialResolver } from "../src/credentials.js";
import { EventHub } from "../src/event-hub.js";
import { ProviderRegistry } from "../src/providers.js";
import { SupervisorStore } from "../src/store.js";
import { RuntimeAgentSupervisor } from "../src/supervisor.js";
import { configuredSkillBindings, readBoundSkills } from "../src/skill-bindings.js";

const digest = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
async function skill(root: string, id: string) {
  const folder = path.join(root, '.agents/skills', id);
  await fs.mkdir(folder, {recursive:true});
  const content = `---\nname: ${id}\ndescription: Local test ${id}\n---\n\nFollow instruction marker SECRET_SKILL_BODY_${id}.\n`;
  await fs.writeFile(path.join(folder, 'SKILL.md'), content);
  return {id, version:'fixture-v1', path:folder, digest:'package-deployment-digest', content_digest:digest(content)};
}

test('explicit skills reject missing, changed, duplicate, escaping and inconsistent bindings', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-validation-'));
  try {
    const one = await skill(root, 'one');
    assert.equal((await readBoundSkills(root, [one]))[0]?.contentDigest, one.content_digest);
    assert.throws(() => configuredSkillBindings({skill_bindings:[one, one]}), /duplicate_skill_binding/);
    assert.throws(() => configuredSkillBindings({skill_bindings:[one],agent_access_snapshot:{skills:['two']}}), /configured_skill_binding_mismatch/);
    assert.throws(() => configuredSkillBindings({skill_bindings:[{...one,content_digest:undefined}]}), /invalid_skill_bindings/);
    assert.throws(() => configuredSkillBindings({skill_bindings:[one]}, {...one,id:'two'}), /turn_skill_not_configured/);
    assert.deepEqual(configuredSkillBindings({skill_bindings:[one]}, {path:one.path,id:one.id,digest:one.digest,version:one.version}), [one]);
    await assert.rejects(readBoundSkills(root,[{...one,path:path.join(root,'missing')}]), /configured_skill_missing/);
    await assert.rejects(readBoundSkills(root,[{...one,content_digest:digest('changed')}]), /configured_skill_content_changed/);
    const child = path.join(root,'inner');await fs.mkdir(child);await fs.symlink(one.path,path.join(child,'escaped'));
    await assert.rejects(readBoundSkills(child,[{...one,path:path.join(child,'escaped')}]), /configured_skill_path_invalid/);
    const legacy = {...one,digest:digest('package tree'),content_digest:undefined};
    assert.equal((await readBoundSkills(root,[legacy])).length,1,'package digests are not SKILL.md hashes');
    assert.throws(() => configuredSkillBindings({agent_access_snapshot:{binding:{skills:[legacy]}}},{...legacy,path:child}),/configured_skill_binding_mismatch/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('real pi sessions load every configured skill on first and resumed turns, pin native bindings and fail before model on drift', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-skills-integration-'));
  const [one,two] = await Promise.all([skill(root,'one'),skill(root,'two')]);
  await skill(root,'unselected');
  const providerDir = path.join(root,'providers');await fs.mkdir(providerDir);
  const requests: Array<{messages:unknown[];tools:Array<{function:{name:string}}>}>=[];
  const model=createServer(async(req,res)=>{
    let body='';for await (const chunk of req) body+=String(chunk);requests.push(JSON.parse(body));
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const choice of [{delta:{role:'assistant',content:'Skill instructions received'},finish_reason:null},{delta:{},finish_reason:'stop'}]) res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'local',choices:[{index:0,...choice}]})}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const address=model.address();assert.ok(address&&typeof address!=='string');
  await fs.writeFile(path.join(providerDir,'local.json'),JSON.stringify({id:'local',protocol:'openai-compatible',provider:'local',model:'local',baseUrl:`http://127.0.0.1:${address.port}/v1`,credentialRef:'env:MODEL_FIXTURE'}));
  const providers=new ProviderRegistry(providerDir),store=new SupervisorStore(path.join(root,'supervisor.db'));
  let beforeWorker: (()=>Promise<void>) | undefined;
  const adapter=new PiAdapter({dataDir:root,providers,credentialResolver:new CredentialResolver(root,{MODEL_FIXTURE:'local-only'}),mcpFactory:async()=>{await beforeWorker?.();return undefined;}});
  const supervisor=new RuntimeAgentSupervisor({host:'127.0.0.1',port:0,dataDir:root,databasePath:path.join(root,'supervisor.db'),credentialDir:root,providerDir,maxConcurrent:1,internalToken:''},store,new EventHub(),providers,[adapter]);
  const base={instanceId:'fixture',engine:'sop-native',providerId:'local',workspace:root};
  try {
    const metadata={preset_id:'configured',tool_allowlist:['read'],skill_bindings:[one,two],agent_access_snapshot:{skills:['one','two']}};
    const {session,execution}=await supervisor.createSession({...base,metadata,firstInstruction:'Follow both Skills'});assert.ok(execution);
    assert.equal((await supervisor.waitForTerminal(execution.id,25000)).execution.status,'completed');
    const second=await supervisor.createTurn(session.id,{instruction:'Continue',metadata:{skill_bindings:[]}});
    const done=await supervisor.waitForTerminal(second.execution.id,25000);assert.equal(done.execution.status,'completed',done.execution.error);
    assert.equal(requests.length,2);
    for(const request of requests){
      const sent=JSON.stringify(request.messages);assert.match(sent,/SECRET_SKILL_BODY_one/);assert.match(sent,/SECRET_SKILL_BODY_two/);assert.doesNotMatch(sent,/SECRET_SKILL_BODY_unselected/);
      assert.deepEqual(request.tools.map(t=>t.function.name),['read']);
    }
    for(const id of [execution.id,second.execution.id]) {
      const events=supervisor.listEvents(id).filter(e=>e.type==='skill.bound');
      assert.equal(events.length,2);assert.ok(events.every(e=>(e.data as Record<string,unknown>).contentLoaded===true));
    }
    await assert.rejects(supervisor.createTurn(session.id,{instruction:'Change skill',skill:{...one,id:'unselected'}}),/turn_skill_not_configured/);
    const legacy={...one,digest:digest('legacy package'),content_digest:undefined};
    const native=await supervisor.createSession({...base,metadata:{tool_allowlist:['read'],agent_access_snapshot:{binding:{skills:[legacy]}}}});
    const nativeOutput=path.join(root,'native-output');await fs.mkdir(nativeOutput);await fs.writeFile(path.join(nativeOutput,'fixture.md'),'Local fixture artifact');
    const nativeTurn=await supervisor.createTurn(native.session.id,{instruction:'Native creator',skill:legacy,outputDir:nativeOutput});
    const nativeDone=await supervisor.waitForTerminal(nativeTurn.execution.id,25000);assert.equal(nativeDone.execution.status,'completed',nativeDone.execution.error);
    const bound=supervisor.listEvents(nativeTurn.execution.id).find(e=>e.type==='skill.bound');
    const evidence=bound?.data as Record<string,unknown>;
    assert.equal(evidence.digest,legacy.digest);assert.equal(evidence.skillPath,legacy.path);assert.equal(evidence.skillName,'one');
    assert.equal((supervisor.getSession(native.session.id)?.metadata.skill_bindings as typeof one[])[0]?.content_digest,one.content_digest);
    const nativeResume=await supervisor.createTurn(native.session.id,{instruction:'Native follow-up'});
    assert.equal((await supervisor.waitForTerminal(nativeResume.execution.id,25000)).execution.status,'completed');
    assert.match(JSON.stringify(requests.at(-1)?.messages),/SECRET_SKILL_BODY_one/);
    const dispatched=requests.length;
    beforeWorker=()=>fs.writeFile(path.join(two.path,'SKILL.md'),'changed after validation');
    const drift=await supervisor.createTurn(session.id,{instruction:'Queued then changed'});
    const failed=await supervisor.waitForTerminal(drift.execution.id,25000);
    assert.equal(failed.execution.status,'failed');assert.match(failed.execution.error,/configured_skill_content_changed/);
    assert.equal(requests.length,dispatched,'queue-time changes never reach the model');
    await assert.rejects(supervisor.createTurn(session.id,{instruction:'Resume changed content'}),/configured_skill_content_changed/);
    await assert.rejects(supervisor.createSession({...base,metadata}),/configured_skill_content_changed/);
  } finally {
    await supervisor.close();store.close();model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});
  }
});
