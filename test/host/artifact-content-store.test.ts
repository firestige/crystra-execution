import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {canonicalDigest} from '../../src/contracts/index.js';
import {ArtifactContentStore} from '../../src/host/artifact-content-store.js';
const roots:string[]=[];afterEach(async()=>{for(const r of roots.splice(0))await rm(r,{recursive:true,force:true});});
it('preserves exact artifact content across restart and rejects changed content and references',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'artifact-content-'));roots.push(root);
 const content={markdown:'# Accepted result'},reference={artifactIdentity:'artifact.one',versionIdentity:'version.one',contentIdentity:canonicalDigest(content)} as never;
 const store=new ArtifactContentStore(root);await store.put(reference,content);
 expect(await new ArtifactContentStore(root).read(reference)).toMatchObject({state:'available',content});
 await expect(store.put(reference,{markdown:'changed'})).rejects.toThrow('ARTIFACT_CONTENT_MISMATCH');
 expect(await store.read({...reference as object,versionIdentity:'wrong'} as never)).toMatchObject({state:'unavailable'});
 await writeFile(path.join(root,canonicalDigest(reference).slice(7)+'.json'),'{}');
 expect(await store.read(reference)).toMatchObject({state:'unavailable'});
});
