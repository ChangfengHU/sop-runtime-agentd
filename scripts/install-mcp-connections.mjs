#!/usr/bin/env node
import fs from 'node:fs/promises';
import { installMcpConnections } from '../dist/src/mcp-install.js';
// Manifest contains endpoint and Vault references only. No credential values or network requests.
try {
 const args=process.argv.slice(2);
 if(args.length!==1)throw Error('usage: install-mcp-connections.mjs <manifest-file>');
 const source=await fs.readFile(args[0],'utf8');
 if(source.length>1_000_000)throw Error('mcp_install_manifest_too_large');
 const result=await installMcpConnections(JSON.parse(source),process.env.SOP_MCP_CREDENTIAL_BINDINGS_FILE||'/etc/sop-runtime-agentd/mcp-credentials.json');
 process.stdout.write(JSON.stringify({ok:true,...result})+'\n');
} catch(error) {
 const message=error instanceof Error&&/^mcp_[a-z_]+$/.test(error.message)?error.message:'mcp_install_failed';
 process.stderr.write(JSON.stringify({ok:false,error:message})+'\n');process.exitCode=1;
}
