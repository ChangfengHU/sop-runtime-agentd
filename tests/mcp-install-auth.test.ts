import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {managedMcpInstallToken} from '../src/mcp-managed-install.js';import{createHttpServer}from'../src/http-server.js';import type{RuntimeAgentSupervisor}from'../src/supervisor.js';
test('installer service key protects the managed route without changing legacy local health access',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'managed-auth-')),file=path.join(dir,'service.key'),old=process.env.SOP_MCP_INSTALL_TOKEN_FILE;process.env.SOP_MCP_INSTALL_TOKEN_FILE=file;
 const server=createHttpServer({config:{internalToken:''},healthSnapshot:()=>({ok:true})} as unknown as RuntimeAgentSupervisor);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const a=server.address();assert.ok(a&&typeof a==='object');const base='http://127.0.0.1:'+a.port;
 try{
  assert.equal((await fetch(base+'/health')).status,200);assert.equal((await fetch(base+'/v1/mcp/install-managed',{method:'POST',body:'{}'})).status,403);
  await fs.writeFile(file,'installer-fixture',{mode:0o640});assert.equal(await managedMcpInstallToken(),'installer-fixture');assert.equal((await fetch(base+'/v1/mcp/install-managed',{method:'POST',body:'{}'})).status,401);
  const response=await fetch(base+'/v1/mcp/install-managed',{method:'POST',headers:{authorization:'Bearer installer-fixture'},body:'{}'});assert.equal(response.status,400);assert.doesNotMatch(await response.text(),/installer-fixture/);
  await fs.chmod(file,0o666);await assert.rejects(managedMcpInstallToken(),/credential_invalid/);await fs.unlink(file);await fs.symlink('/does-not-exist',file);await assert.rejects(managedMcpInstallToken(),/credential_invalid/);
 }finally{await new Promise<void>(r=>server.close(()=>r()));if(old===undefined)delete process.env.SOP_MCP_INSTALL_TOKEN_FILE;else process.env.SOP_MCP_INSTALL_TOKEN_FILE=old;await fs.rm(dir,{recursive:true,force:true});}
});
