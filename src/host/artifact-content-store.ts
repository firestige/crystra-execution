import {lstat,mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonicalDigest,type ArtifactVersionRef,type FrozenJsonValue} from '../contracts/index.js';
export type ArtifactContentView=Readonly<{state:'available';reference:ArtifactVersionRef;content:FrozenJsonValue}>|Readonly<{state:'unavailable';reason:string}>;
/** Host-owned immutable JSON output archive. A digest is never interpreted as a workspace path. */
export class ArtifactContentStore{
 constructor(readonly root:string){}
 #file(reference:ArtifactVersionRef):string{return path.join(this.root,canonicalDigest(reference).slice(7)+'.json');}
 async put(reference:ArtifactVersionRef,content:FrozenJsonValue):Promise<void>{
  if(canonicalDigest(content)!==reference.contentIdentity)throw Error('ARTIFACT_CONTENT_MISMATCH');
  const bytes=JSON.stringify({reference,content});if(Buffer.byteLength(bytes)>16*1024*1024)throw Error('ARTIFACT_CONTENT_TOO_LARGE');
  await mkdir(this.root,{recursive:true,mode:0o700});const file=this.#file(reference),temp=file+'.'+randomUUID()+'.new';
  await writeFile(temp,bytes,{mode:0o600});await rename(temp,file);
 }
 async read(reference:ArtifactVersionRef):Promise<ArtifactContentView>{
  try{
   const file=this.#file(reference),stat=await lstat(file);if(!stat.isFile()||stat.size>16*1024*1024)throw Error('ARTIFACT_CONTENT_INVALID');
   const value=JSON.parse(await readFile(file,'utf8'));
   if(canonicalDigest(value.reference)!==canonicalDigest(reference)||canonicalDigest(value.content)!==reference.contentIdentity)throw Error('ARTIFACT_CONTENT_MISMATCH');
   return {state:'available',reference,content:value.content as FrozenJsonValue};
  }catch{return {state:'unavailable',reason:'ARTIFACT_CONTENT_UNAVAILABLE'};}
 }
}
