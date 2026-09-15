import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareDelegation} from '../src/delegation-tools.js';
import {mergeTurnMetadata} from '../src/tool-policy.js';
const context={id:'execution',sessionId:'parent',metadata:{tool_allowlist:['delegate_agent'],delegation_context:{version:1},agent_access_snapshot:{runtime_id:'ordinary'}}};
test('delegation context comes from execution, never model arguments',async()=>{
 let sent:any;
 const bridge=prepareDelegation(context,new AbortController().signal,async(_url,init)=>{sent=JSON.parse(String(init?.body));return Response.json({ok:true,result:{id:'task',status:'queued'}})});
 assert.deepEqual(bridge?.tools.map(t=>t.id),['delegate_agent']);
 await bridge!.call('delegate_agent',{runtime_id:'forged',session_id:'forged',agent_id:'target'});
 assert.equal(bridge!.submitted,true);
 assert.equal(sent.runtime_id,'ordinary');assert.equal(sent.session_id,'parent');assert.equal(sent.execution_id,'execution');
 await assert.rejects(bridge!.call('cancel_delegation',{}),/denied/);
});
test('unconfigured and child sessions cannot delegate; turns cannot replace child or policy binding',()=>{
 assert.equal(prepareDelegation({...context,metadata:{}},new AbortController().signal),undefined);
 assert.equal(prepareDelegation({...context,metadata:{...context.metadata,delegation_binding:{id:'child'}}},new AbortController().signal),undefined);
 const merged=mergeTurnMetadata({...context.metadata,delegation_binding:{id:'child'}},{delegation_context:{version:99},delegation_binding:null});
 assert.deepEqual(merged.delegation_context,{version:1});assert.deepEqual(merged.delegation_binding,{id:'child'});
});
