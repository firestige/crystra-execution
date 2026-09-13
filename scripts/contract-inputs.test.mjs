import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
test('generated contracts resolve exact inputs inside the component checkout',()=>{
 const result=spawnSync(process.execPath,['scripts/generate-workflow-contract.ts','--check'],{cwd:root,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});
