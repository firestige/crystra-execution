import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,lstat,unlink} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {canonicalDigest,type FrozenJsonValue,type PreservedResultRef} from '../contracts/index.js';
import type {PreservedBusinessResultView} from '../custody/git-custody.js';
export interface DeliveryResultBinding {readonly taskId:string;readonly deliveryId:string;readonly deliveryBindingIdentity:string}
interface Record {readonly binding:DeliveryResultBinding;readonly reference:PreservedResultRef}
export type DeliveryBusinessResultView = PreservedBusinessResultView | Readonly<{state:'unavailable';reason:'DELIVERY_RESULT_NOT_FOUND'|'DELIVERY_RESULT_CORRUPT'}>;
const digest=(value:unknown)=>canonicalDigest(value as FrozenJsonValue);
const filename=(id:string)=>`${createHash('sha256').update(id).digest('hex')}.json`;
/** Stores an owner-issued result reference; business bytes are read only through custody. */
export class DeliveryBusinessResultJournal {
 constructor(private readonly root:string){if(!isAbsolute(root))throw new TypeError('DELIVERY_RESULT_ROOT_INVALID');}
 async persist(binding:DeliveryResultBinding,reference:PreservedResultRef):Promise<void>{
  if(!binding.taskId||!binding.deliveryId||reference.delivery.deliveryIdentity!==binding.deliveryId||reference.delivery.manifestBindingIdentity!==binding.deliveryBindingIdentity)throw Error('DELIVERY_RESULT_BINDING_CHANGED');
  const value:Record={binding:{taskId:binding.taskId,deliveryId:binding.deliveryId,deliveryBindingIdentity:binding.deliveryBindingIdentity},reference},file=join(this.root,filename(binding.deliveryId));
  await mkdir(this.root,{recursive:true,mode:0o700});
  try{const existing=await this.load(binding.deliveryId);if(digest(existing)!==digest(value))throw Error('DELIVERY_RESULT_BINDING_CHANGED');return;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const temporary=`${file}.${randomUUID()}.new`;
  try{await writeFile(temporary,JSON.stringify(value),{mode:0o600,flag:'wx'});await rename(temporary,file);}finally{await unlink(temporary).catch(()=>undefined);}
 }
 private async load(deliveryId:string):Promise<Record>{
  const file=join(this.root,filename(deliveryId)),stat=await lstat(file);
  if(!stat.isFile()||stat.size>64*1024)throw Error('DELIVERY_RESULT_CORRUPT');
  const value=JSON.parse(await readFile(file,'utf8')) as Record;
  if(value.binding?.deliveryId!==deliveryId||typeof value.binding.taskId!=='string'||!value.binding.taskId||value.reference?.delivery?.deliveryIdentity!==deliveryId||value.reference.delivery.manifestBindingIdentity!==value.binding.deliveryBindingIdentity)throw Error('DELIVERY_RESULT_CORRUPT');
  return value;
 }
 async read(request:Readonly<{taskId:string;deliveryId:string}>,readCustody:(reference:PreservedResultRef)=>Promise<PreservedBusinessResultView>):Promise<DeliveryBusinessResultView>{
  let value:Record;
  try{value=await this.load(request.deliveryId);}catch(error){return {state:'unavailable',reason:(error as NodeJS.ErrnoException).code==='ENOENT'?'DELIVERY_RESULT_NOT_FOUND':'DELIVERY_RESULT_CORRUPT'};}
  if(value.binding.taskId!==request.taskId)return {state:'unavailable',reason:'DELIVERY_RESULT_NOT_FOUND'};
  return readCustody(value.reference);
 }
}
