import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {configuredSkillBindings,readBoundSkills} from '../src/skill-bindings.js';
import {mergeTurnMetadata} from '../src/tool-policy.js';
async function fixture(){
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'capability-release-')),root=path.join(workspace,'.sop/capability-skills/frozen/example');
 await fs.mkdir(path.join(root,'references'),{recursive:true});const files={'SKILL.md':'---\nname: example\ndescription: fixture\n---\n# Example','references/format.md':'# Frozen format'};
 for(const [name,content] of Object.entries(files))await fs.writeFile(path.join(root,name),content);
 const hash=(text:string)=>'sha256:'+createHash('sha256').update(text).digest('hex');
 const binding={id:'example',version:'1.0.0',path:root,digest:'deployment',content_digest:hash(files['SKILL.md']),release_ref:{capabilityId:'skill:test/example',releaseId:'release-1',manifestDigest:'sha256:'+'1'.repeat(64)},files:Object.entries(files).map(([name,content])=>({path:name,sha256:hash(content)}))};
 return {workspace,root,binding,cleanup:()=>fs.rm(workspace,{recursive:true,force:true})};
}
test('fixed release loads verified complete Skill inventory',async()=>{const f=await fixture();try{const bindings=configuredSkillBindings({skill_bindings:[f.binding],agent_access_snapshot:{skills:['example']}});const loaded=await readBoundSkills(f.workspace,bindings);assert.equal(loaded[0]?.binding.release_ref?.releaseId,'release-1');assert.match(loaded[0]!.content,/# Example/);}finally{await f.cleanup();}});
for(const change of ['changed-reference','missing-reference','extra-file','symlink'] as const)test(`release inventory rejects ${change} before model execution`,async()=>{const f=await fixture();try{
 if(change==='changed-reference')await fs.writeFile(path.join(f.root,'references/format.md'),'modified');
 if(change==='missing-reference')await fs.unlink(path.join(f.root,'references/format.md'));
 if(change==='extra-file')await fs.writeFile(path.join(f.root,'unexpected.sh'),'echo unexpected');
 if(change==='symlink'){await fs.unlink(path.join(f.root,'references/format.md'));await fs.symlink(path.join(f.root,'SKILL.md'),path.join(f.root,'references/format.md'));}
 await assert.rejects(readBoundSkills(f.workspace,[f.binding]),/configured_skill_inventory/);
}finally{await f.cleanup();}});
test('a release reference cannot omit its file inventory',async()=>{const f=await fixture();try{const {files,...binding}=f.binding;await assert.rejects(readBoundSkills(f.workspace,[binding]),/release_inventory_required/);}finally{await f.cleanup();}});
test('turn metadata cannot replace pinned release snapshot or binding identity',()=>{const snapshot={bindingId:'binding-old',releases:[{releaseId:'release-old'}]};const result=mergeTurnMetadata({tool_allowlist:['read'],capability_binding_id:'binding-old',capability_snapshot:snapshot},{capability_binding_id:'binding-new',capability_snapshot:{releaseId:'new'}});assert.equal(result.capability_binding_id,'binding-old');assert.deepEqual(result.capability_snapshot,snapshot);});
