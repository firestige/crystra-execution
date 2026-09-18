import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {DeliveryBusinessResultJournal} from '../../src/delivery/business-result-journal.js';
import type {PreservedResultRef} from '../../src/contracts/index.js';
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));roots.length=0;});
it('keeps exact Task and Delivery associations after restart and rejects another Task before reading custody',async()=>{
 const root=await mkdtemp(join(tmpdir(),'crystra-result-journal-'));roots.push(root);
 const reference={identity:'result-1',delivery:{deliveryIdentity:'d1',manifestBindingIdentity:'sha256:m',activationBindingIdentity:'sha256:a'},contentIdentity:'sha256:r',savepoint:{state:'unknown',owner:'custody',reason:'CALL_INTERRUPTED'}} as unknown as PreservedResultRef;
 const binding={taskId:'t1',deliveryId:'d1',deliveryBindingIdentity:'sha256:m'};
 const journal=new DeliveryBusinessResultJournal(root);await journal.persist(binding,reference);
 const restored=new DeliveryBusinessResultJournal(root);const calls:string[]=[];
 const reader=async(ref:PreservedResultRef)=>{calls.push(ref.identity);return {state:'unavailable' as const,reason:'PRESERVED_RESULT_MISSING' as const};};
 expect(await restored.read({taskId:'t2',deliveryId:'d1'},reader)).toMatchObject({reason:'DELIVERY_RESULT_NOT_FOUND'});expect(calls).toEqual([]);
 const read=await restored.read({taskId:'t1',deliveryId:'d1'},reader);expect(read).toMatchObject({reason:'PRESERVED_RESULT_MISSING'});expect(calls).toEqual(['result-1']);
 await expect(journal.persist({...binding,taskId:'t2'},reference)).rejects.toThrow('DELIVERY_RESULT_BINDING_CHANGED');
});
