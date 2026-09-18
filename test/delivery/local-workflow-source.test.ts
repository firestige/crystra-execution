import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LocalWorkflowPackageSource, createConfiguredWorkflowPackageSource, WorkflowPackageSourceRegistry, WorkflowPackageResolver, WorkflowPackageStore, FrozenWorkflowPackageValidatorV2 } from "../../src/delivery/index.js";
import { packLocalWorkflow } from "../../src/delivery/local-workflow-pack.js";
import { canonicalDigest } from "../../src/contracts/index.js";

const sha = (body: Uint8Array) => `sha256:${createHash('sha256').update(body).digest('hex')}`;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'workflow-local-'));
  const bytes = Buffer.from('local archive');
  const archive = join(root, 'demo.tar.gz');
  const index = join(root, 'source.json');
  const entry = { name: 'demo', version: '1.2.3-rc.1', archive: 'demo.tar.gz', archiveDigest: sha(bytes) };
  await writeFile(archive, bytes);
  await writeFile(index, JSON.stringify({ schemaVersion: 'execution.local-workflow-source@1.0.0', packages: [entry] }));
  return { root, index, archive, bytes, entry, source: new LocalWorkflowPackageSource(index) };
}
const request = { name: 'demo', version: { kind: 'EXACT', value: '1.2.3-rc.1' } } as const;
describe('private local Workflow source', () => {
  it('packs an unpublished RC and admits it through the real frozen validator', async () => {
    const root=await mkdtemp(join(tmpdir(),'local-workflow-pack-'));
    const pkgRoot=join(root,'package');
    await cp('.crystra-inputs/workflow-package/hello-world-workflow',pkgRoot,{recursive:true});
    const packageFile=join(pkgRoot,'definition/package.json'),snapshotFile=join(pkgRoot,'definition/snapshot.json');
    const pkg=JSON.parse(await readFile(packageFile,'utf8'));
    pkg.package.version='0.2.1-rc.1';delete pkg.package.digest;pkg.package.digest=canonicalDigest(pkg);
    await writeFile(packageFile,JSON.stringify(pkg));
    const snapshot=JSON.parse(await readFile(snapshotFile,'utf8'));
    snapshot.snapshot.package.version=pkg.package.version;snapshot.snapshot.package.digest=pkg.package.digest;
    delete snapshot.snapshot.digest;snapshot.snapshot.digest=canonicalDigest(snapshot);
    await writeFile(snapshotFile,JSON.stringify(snapshot));
    const index=join(root,'private/source.json');
    const result=await packLocalWorkflow(pkgRoot,index);
    await expect(packLocalWorkflow(pkgRoot,index)).resolves.toEqual(result);
    expect(result.selector).toBe('hello-world-workflow@0.2.1-rc.1');
    const source=new LocalWorkflowPackageSource(index);
    const store=new WorkflowPackageStore({readyRoot:join(root,'cache'),stagingRoot:join(root,'staging')});
    const resolver=new WorkflowPackageResolver(store,source,new FrozenWorkflowPackageValidatorV2({contractVersion:'2.0.0',providerIdentity:'provider.registry',providerCapabilities:['structured-completion','action-interaction'],hostCapabilities:['deterministic-validation','deterministic-selection','deterministic-transformation']}));
    await expect(resolver.resolve(result.selector)).resolves.toMatchObject({ok:true,value:{exactVersion:'0.2.1-rc.1'}});
    await expect(resolver.resolve('hello-world-workflow@latest')).resolves.toMatchObject({ok:false,error:{code:'WORKFLOW_EXACT_VERSION_REQUIRED'}});
    await expect(resolver.resolve('hello-world-workflow@^0.2.1')).resolves.toMatchObject({ok:false,error:{code:'INVALID_WORKFLOW_SELECTOR'}});
    await writeFile(join(pkgRoot,'extra.txt'),'new bytes');
    await expect(packLocalWorkflow(pkgRoot,index)).rejects.toThrow('LOCAL_VERSION_ALREADY_EXISTS');
    const catalog=JSON.parse(await readFile(index,'utf8'));
    await writeFile(join(root,'private',catalog.packages[0].archive),'modified archive');
    await expect(resolver.resolve(result.selector)).resolves.toMatchObject({ok:false,error:{code:'WORKFLOW_DIGEST_MISMATCH'}});
  });
  it('loads an exact unpublished RC without a network port and rejects latest', async () => {
    const f = await fixture();
    await expect(f.source.fetch(request)).resolves.toMatchObject({ kind: 'FOUND', candidate: { name: 'demo', exactVersion: '1.2.3-rc.1', archiveDigest: sha(f.bytes), archive: f.bytes } });
    await expect(f.source.fetch({name:'demo',version:{kind:'LATEST'}})).resolves.toEqual({kind:'INVALID'});
    await expect(f.source.fetch({...request,version:{kind:'EXACT',value:'1.2.3-rc.2'}})).resolves.toEqual({kind:'NOT_FOUND'});
  });
  it('registers the built-in adapter without host injection', async () => {
    const f=await fixture(), network={request:vi.fn()};
    const source=createConfiguredWorkflowPackageSource({kind:'adapter',adapterKey:'workflow.local.v1',adapterConfigFile:f.index},network,new WorkflowPackageSourceRegistry({}));
    await expect(source.fetch(request)).resolves.toMatchObject({kind:'FOUND'});
    expect(network.request).not.toHaveBeenCalled();
  });
  it('rejects changed bytes, duplicate coordinates and files outside the private source', async () => {
    const f=await fixture();
    await writeFile(f.archive,'changed');
    await expect(f.source.fetch(request)).resolves.toEqual({kind:'DIGEST_MISMATCH'});
    for (const packages of [[f.entry,f.entry],[{...f.entry,archive:'../outside.tar.gz'}],[{...f.entry,archive:'https://example.com/a.tar.gz'}]]) {
      await writeFile(f.index,JSON.stringify({schemaVersion:'execution.local-workflow-source@1.0.0',packages}));
      await expect(f.source.fetch(request)).resolves.toEqual({kind:'INVALID'});
    }
    await symlink(f.archive,join(f.root,'link.tar.gz'));
    await writeFile(f.index,JSON.stringify({schemaVersion:'execution.local-workflow-source@1.0.0',packages:[{...f.entry,archive:'link.tar.gz'}]}));
    await expect(f.source.fetch(request)).resolves.toEqual({kind:'INVALID'});
  });
  it('enforces selection policy before a cache hit', async () => {
    const f=await fixture();
    const store=new WorkflowPackageStore({readyRoot:join(f.root,'cache'),stagingRoot:join(f.root,'staging')});
    const cached=vi.spyOn(store,'lookupExact').mockResolvedValue({name:'demo',exactVersion:'1.2.3-rc.1',packageDigest:sha(f.bytes),localPath:f.root,workflowId:'demo'});
    const fetch=vi.fn(async()=>({kind:'NOT_FOUND' as const}));
    const resolver=new WorkflowPackageResolver(store,{fetch},{validate:vi.fn()});
    await expect(resolver.resolve('demo@1.2.3-rc.1')).resolves.toMatchObject({ok:false,error:{code:'WORKFLOW_PRERELEASE_REQUIRES_PRIVATE_SOURCE'}});
    expect(cached).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
    vi.spyOn(store,'lookupLatest').mockResolvedValue({name:'demo',exactVersion:'1.2.3-rc.1',packageDigest:sha(f.bytes),localPath:f.root,workflowId:'demo'});
    await expect(resolver.resolve('demo@latest')).resolves.toMatchObject({ok:false,error:{code:'WORKFLOW_PRERELEASE_REQUIRES_PRIVATE_SOURCE'}});
    const local=new WorkflowPackageResolver(store,f.source,{validate:vi.fn()});
    await expect(local.resolve('demo')).resolves.toMatchObject({ok:false,error:{code:'WORKFLOW_EXACT_VERSION_REQUIRED'}});
  });
});
