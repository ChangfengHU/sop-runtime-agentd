import type { ExecutionRecord } from './contracts.js';
import type { McpModelTool } from './mcp-session.js';
const schema = (properties:Record<string,object>,required:string[]=[]) => ({type:'object' as const,properties,required,additionalProperties:false});
export const delegationTools: McpModelTool[] = [
 {id:'list_delegate_agents',name:'list_delegate_agents',description:'查询当前 Runtime 已授权的委派 Agent、能力和可用性。列表不代表这些能力已安装到你自身。',inputSchema:schema({}),schema_digest:'builtin:delegation-v1'},
 {id:'delegate_agent',name:'delegate_agent',description:'向已授权 Agent 发起一次独立任务，无需 Action。返回 queued 后结束当前轮次；系统将自动把结果送回本会话。不要轮询等待，不得声称已完成。task 必须限定本次授权范围并给出验收要求。',inputSchema:schema({agent_id:{type:'string'},task:{type:'string',maxLength:16000},request_id:{type:'string',pattern:'^[a-zA-Z0-9_.-]{1,96}$',description:'同一次委派重试必须复用此值'}},['agent_id','task','request_id']),schema_digest:'builtin:delegation-v1'},
 {id:'get_delegation',name:'get_delegation',description:'按用户要求查看本会话委派状态。系统会自动通知完成结果，不要循环查询。',inputSchema:schema({id:{type:'string'}},['id']),schema_digest:'builtin:delegation-v1'},
 {id:'cancel_delegation',name:'cancel_delegation',description:'取消本会话的一次委派，取消请求不代表已回滚产生的结果。',inputSchema:schema({id:{type:'string'}},['id']),schema_digest:'builtin:delegation-v1'},
];
export function prepareDelegation(execution:Pick<ExecutionRecord,'id'|'sessionId'|'metadata'>,signal:AbortSignal,transport:typeof fetch=fetch) {
 const meta=execution.metadata,snapshot=meta.agent_access_snapshot as Record<string,unknown>|undefined;
 if(!meta.delegation_context||meta.delegation_binding||!snapshot?.runtime_id)return undefined;
 const tools=delegationTools.filter(tool=>(meta.tool_allowlist as string[]|undefined)?.includes(tool.id));
 if(!tools.length)return undefined;
 return {tools,async call(name:string,args:unknown){
  if(!tools.some(t=>t.id===name))throw Error('delegation_tool_denied');
  const origin=process.env.SOP_MCP_CONTROL_URL||'https://control.vyibc.com';
  if(new URL(origin).protocol!=='https:')throw Error('delegation_endpoint_invalid');
  const response=await transport(new URL('/api/agent-delegations/tools',origin),{method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(60000)]),headers:{'content-type':'application/json'},body:JSON.stringify({runtime_id:snapshot.runtime_id,session_id:execution.sessionId,execution_id:execution.id,tool:name,arguments:args})});
  const result=await response.json() as {ok?:boolean;error?:string;result?:unknown};
  if(!response.ok||!result.ok)throw Error(/^delegation_[a-z_:]+$/.test(result.error||'')?result.error:'delegation_request_failed');
  return {content:[{type:'text',text:JSON.stringify(result.result)}]};
 }};
}
