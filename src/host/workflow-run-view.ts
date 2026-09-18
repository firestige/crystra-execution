import {mkdir,readFile,writeFile,rename,lstat} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonicalDigest,type CompiledGraphActivation} from '../contracts/index.js';
export interface RunVisit {id:string;target:string;enteredAt:string}
export interface WorkflowRunView {schema:'execution.workflow-run-view@1';taskId:string;deliveryId:string;workflowRunId:string;workflowId:string;bindingIdentity:string;updatedAt:string;currentTarget:string;status:string;visits:RunVisit[];control:CompiledGraphActivation['plan']['control']}
/** Read-only owner projection. It never supplies a resume handle or a new runtime identity. */
export class WorkflowRunViewStore {
 constructor(readonly root:string){}
 async put(value:WorkflowRunView):Promise<void>{await mkdir(this.root,{recursive:true,mode:0o700});const file=path.join(this.root,'workflow-run.json'),temp=file+'.'+randomUUID()+'.new';await writeFile(temp,JSON.stringify({value,digest:canonicalDigest(value)}),{mode:0o600});await rename(temp,file);}
 async read(request:{taskId:string;deliveryId:string}):Promise<{state:'available';value:WorkflowRunView}|{state:'unavailable';reason:string}>{try{const file=path.join(this.root,'workflow-run.json'),stat=await lstat(file);if(!stat.isFile()||stat.size>16*1024*1024)throw Error();const {value,digest}=JSON.parse(await readFile(file,'utf8'));if(digest!==canonicalDigest(value)||value.taskId!==request.taskId||value.deliveryId!==request.deliveryId)throw Error();return {state:'available',value};}catch{return {state:'unavailable',reason:'WORKFLOW_RUN_UNAVAILABLE'};}}
}
