import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { NetworkPort } from "../../src/bootstrap/index.js";
import { GitHubWorkflowPackageSource } from "../../src/delivery/index.js";

const bytes = (value: unknown): Uint8Array => Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
const sha256 = (value: Uint8Array): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const configuration = {
  kind: "github", repository: "example/workflows",
  releasesBaseUrl: "https://api.github.com/repos/example/workflows/releases",
  assetPattern: "workflow-package-{name}-{version}.tar.gz",
} as const;

type PackageSpec = Readonly<{ name: string; version: string; prerelease?: boolean; draft?: boolean }>;

function packageRelease(spec: PackageSpec) {
  const prefix = `workflow-package-${spec.name}-${spec.version}`;
  const archive = bytes(`${spec.name}@${spec.version}`);
  const urls = {
    archive: `https://example.test/${prefix}.tar.gz`,
    descriptor: `https://example.test/${prefix}.json`,
    checksum: `https://example.test/${prefix}.tar.gz.sha256`,
    provenance: `https://example.test/${prefix}.provenance.json`,
  };
  const provenance = bytes({
    schemaVersion: "workflow-package.provenance@1.0.0",
    subject: { name: `${prefix}.tar.gz`, sha256: sha256(archive) },
    source: { repository: "example/workflows", revision: "a".repeat(40) },
    contract: { repository: "firestige/crystra-contracts", revision: "b".repeat(40) },
    builder: { workflow: ".github/workflows/release-candidate.yml" },
  });
  const descriptor = bytes({
    schemaVersion: "workflow-package.package-release@2.0.0",
    tag: `crystra-workflow-package/${spec.name}/v${spec.version}`,
    package: { name: spec.name, version: spec.version, digest: `sha256:${"c".repeat(64)}` },
    archive: { name: `${prefix}.tar.gz`, sha256: sha256(archive), bytes: archive.byteLength },
    checksum: { name: `${prefix}.tar.gz.sha256` },
    provenance: { name: `${prefix}.provenance.json`, sha256: sha256(provenance) },
    contract: {
      repository: "firestige/crystra-contracts", revision: "b".repeat(40),
      minVersion: "1.1.0", maxVersion: "1.1.0",
    },
  });
  return {
    release: {
      tag_name: `crystra-workflow-package/${spec.name}/v${spec.version}`,
      draft: spec.draft ?? false,
      prerelease: spec.prerelease ?? false,
      assets: [
        { name: `${prefix}.tar.gz`, browser_download_url: urls.archive },
        { name: `${prefix}.json`, browser_download_url: urls.descriptor },
        { name: `${prefix}.tar.gz.sha256`, browser_download_url: urls.checksum },
        { name: `${prefix}.provenance.json`, browser_download_url: urls.provenance },
      ],
    },
    responses: new Map<string, Readonly<{ status: number; body: Uint8Array }>>([
      [urls.archive, { status: 200, body: archive }],
      [urls.descriptor, { status: 200, body: descriptor }],
      [urls.checksum, { status: 200, body: bytes(`${sha256(archive).slice(7)}  ${prefix}.tar.gz\n`) }],
      [urls.provenance, { status: 200, body: provenance }],
    ]),
  };
}

function source(specs: readonly PackageSpec[], calls: string[] = []) {
  const fixtures = specs.map(packageRelease);
  const responses = new Map(fixtures.flatMap((fixture) => [...fixture.responses]));
  const network: NetworkPort = Object.freeze({ request: async (url: string) => {
    calls.push(url);
    if (url.includes("?per_page=")) return { status: 200, body: bytes(fixtures.map((fixture) => fixture.release)) };
    return responses.get(url) ?? { status: 404, body: bytes("missing") };
  } });
  return new GitHubWorkflowPackageSource(configuration, network);
}

function sourceFromReleases(releases: readonly unknown[], responses: ReadonlyMap<string, Readonly<{ status: number; body: Uint8Array }>>) {
  const network: NetworkPort = Object.freeze({ request: async (url: string) => {
    if (url.includes("?per_page=")) return { status: 200, body: bytes(releases) };
    return responses.get(url) ?? { status: 404, body: bytes("missing") };
  } });
  return new GitHubWorkflowPackageSource(configuration, network);
}

describe("package-scoped GitHub Workflow Source", () => {
  it("selects an exact package through the package-scoped V2 release", async () => {
    const calls: string[] = [];
    await expect(source([
      { name: "unrelated", version: "9.0.0" },
      { name: "demo", version: "1.0.0" },
      { name: "demo", version: "2.0.0" },
    ], calls).fetch({ name: "demo", version: { kind: "EXACT", value: "2.0.0" } })).resolves.toMatchObject({
      kind: "FOUND", candidate: { name: "demo", exactVersion: "2.0.0" },
    });
    expect(calls[0]).toBe("https://api.github.com/repos/example/workflows/releases?per_page=100&page=1");
    expect(calls).not.toContain("https://api.github.com/repos/example/workflows/releases/latest");
  });

  it("admits an exact prerelease but excludes all prereleases from latest", async () => {
    const candidate = source([{ name: "demo", version: "2.0.0-rc.2", prerelease: true }]);
    await expect(candidate.fetch({ name: "demo", version: { kind: "LATEST" } })).resolves.toEqual({ kind: "NOT_FOUND" });
    await expect(candidate.fetch({ name: "demo", version: { kind: "EXACT", value: "2.0.0-rc.2" } })).resolves.toMatchObject({
      kind: "FOUND", candidate: { exactVersion: "2.0.0-rc.2" },
    });
  });

  it("isolates an exact version from same-package historical prerelease, legacy, and damaged assets", async () => {
    const target = packageRelease({ name: "demo", version: "2.0.0" });
    const unrelated = [
      {
        tag_name: "crystra-workflow-package/demo/v1.9.0-rc.1", draft: false, prerelease: false,
        assets: [],
      },
      {
        tag_name: "crystra-workflow-package/demo/v1.0.0", draft: false, prerelease: false,
        assets: [
          { name: "workflow-package-demo-1.0.0.tar.gz", browser_download_url: "https://example.test/legacy-archive" },
          { name: "workflow-package-demo-1.0.0.json", browser_download_url: "https://example.test/legacy-descriptor" },
          { name: "workflow-package-demo-1.0.0.tar.gz.sha256", browser_download_url: "https://example.test/legacy-checksum" },
        ],
      },
      {
        tag_name: "crystra-workflow-package/demo/v1.5.0", draft: false, prerelease: false,
        assets: [
          { name: "workflow-package-demo-1.5.0.tar.gz", browser_download_url: "not-a-url" },
        ],
      },
    ];

    await expect(sourceFromReleases([...unrelated, target.release], target.responses).fetch({
      name: "demo", version: { kind: "EXACT", value: "2.0.0" },
    })).resolves.toMatchObject({
      kind: "FOUND", candidate: { name: "demo", exactVersion: "2.0.0" },
    });
  });

  it("fails closed when the exact target release is missing, duplicated, or invalid", async () => {
    const target = packageRelease({ name: "demo", version: "2.0.0" });
    const request = { name: "demo", version: { kind: "EXACT", value: "2.0.0" } } as const;

    await expect(source([{ name: "demo", version: "1.0.0" }]).fetch(request))
      .resolves.toEqual({ kind: "NOT_FOUND" });
    await expect(sourceFromReleases([target.release, target.release], target.responses).fetch(request))
      .resolves.toEqual({ kind: "INVALID" });
    await expect(sourceFromReleases([{ ...target.release, assets: target.release.assets.slice(0, 3) }], target.responses).fetch(request))
      .resolves.toEqual({ kind: "INVALID" });
  });

  it("selects the highest stable SemVer and ignores drafts", async () => {
    const candidate = source([
      { name: "demo", version: "11.0.0", draft: true },
      { name: "demo", version: "2.9.0" },
      { name: "demo", version: "11.0.0-rc.1", prerelease: true },
      { name: "demo", version: "10.1.0" },
    ]);
    await expect(candidate.fetch({ name: "demo", version: { kind: "LATEST" } })).resolves.toMatchObject({
      kind: "FOUND", candidate: { exactVersion: "10.1.0" },
    });
  });

  it("paginates deterministically and rejects duplicate package versions", async () => {
    const fixture = packageRelease({ name: "demo", version: "1.0.0" });
    const filler = Array.from({ length: 100 }, (_, index) => ({
      ...packageRelease({ name: "other", version: `1.0.${index}` }).release,
      draft: true,
    }));
    const calls: string[] = [];
    const candidate = new GitHubWorkflowPackageSource(configuration, Object.freeze({ request: async (url: string) => {
      calls.push(url);
      return { status: 200, body: bytes(url.endsWith("page=1") ? filler : [fixture.release, fixture.release]) };
    } }));
    await expect(candidate.fetch({ name: "demo", version: { kind: "LATEST" } })).resolves.toEqual({ kind: "INVALID" });
    expect(calls.slice(0, 2)).toEqual([
      "https://api.github.com/repos/example/workflows/releases?per_page=100&page=1",
      "https://api.github.com/repos/example/workflows/releases?per_page=100&page=2",
    ]);
  });

  it("fails closed on malformed collections and bounds release enumeration", async () => {
    const request = { name: "demo", version: { kind: "EXACT", value: "1.0.0" } } as const;
    const withNetwork = (network: NetworkPort) => new GitHubWorkflowPackageSource(configuration, network);
    await expect(withNetwork(Object.freeze({ request: async () => ({ status: 200, body: bytes({}) }) })).fetch(request))
      .resolves.toEqual({ kind: "INVALID" });
    await expect(withNetwork(Object.freeze({ request: async () => ({
      status: 200,
      body: bytes([{ ...packageRelease({ name: "demo", version: "1.0.0" }).release, assets: [] }]),
    }) })).fetch(request)).resolves.toEqual({ kind: "INVALID" });
    let pages = 0;
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      ...packageRelease({ name: "other", version: `1.0.${index}` }).release,
      draft: true,
    }));
    await expect(withNetwork(Object.freeze({ request: async () => {
      pages += 1;
      return { status: 200, body: bytes(fullPage) };
    } })).fetch({ name: "demo", version: { kind: "LATEST" } })).resolves.toEqual({ kind: "UNAVAILABLE" });
    expect(pages).toBe(10);
  });
});

function aggregateFixture(tag = "crystra-workflow-package-v0.1.0-rc.1") {
  const item = packageRelease({ name: "demo", version: "2.0.0" });
  const manifest = bytes({
    schemaVersion: "crystra.workflow-assets-release@2.0.0",
    repository: configuration.repository,
    revision: "a".repeat(40),
    contract: {
      repository: "firestige/crystra-contracts",
      revision: "b".repeat(40),
    },
    packages: [
      {
        tag: item.release.tag_name,
        package: {
          name: "demo",
          version: "2.0.0",
          digest: `sha256:${"c".repeat(64)}`,
        },
        assets: item.release.assets.map((a, i) => ({
          kind: ["archive", "descriptor", "checksum", "provenance"][i],
          name: a.name,
          bytes: item.responses.get(a.browser_download_url)!.body.byteLength,
          sha256: sha256(item.responses.get(a.browser_download_url)!.body),
        })),
      },
    ],
  });
  const qualification = bytes({
    schemaVersion: "crystra.release-qualification@1.0.0",
    candidateTag: tag,
    commit: "a".repeat(40),
    artifactMetadataSha256: sha256(manifest),
    localAcceptance: { status: "PASS" },
    remoteQualification: { status: "PASS" },
  });
  item.responses.set(`https://example.test/${tag}/metadata`, {
    status: 200,
    body: manifest,
  });
  item.responses.set(`https://example.test/${tag}/qualification`, {
    status: 200,
    body: qualification,
  });
  return {
    responses: item.responses,
    release: {
      ...item.release,
      tag_name: tag,
      prerelease: true,
      assets: [
        ...item.release.assets,
        {
          name: "release-metadata.json",
          browser_download_url: `https://example.test/${tag}/metadata`,
        },
        {
          name: "release-qualification.json",
          browser_download_url: `https://example.test/${tag}/qualification`,
        },
      ],
    },
  };
}
describe("qualified aggregate Workflow RC", () => {
  it("resolves an exact package without publishing GA, while latest excludes the RC", async () => {
    const f = aggregateFixture();
    const s = sourceFromReleases([f.release], f.responses);
    await expect(
      s.fetch({ name: "demo", version: { kind: "EXACT", value: "2.0.0" } }),
    ).resolves.toMatchObject({
      kind: "FOUND",
      candidate: { exactVersion: "2.0.0" },
    });
    await expect(
      s.fetch({ name: "demo", version: { kind: "LATEST" } }),
    ).resolves.toEqual({ kind: "NOT_FOUND" });
  });
  it("rejects unqualified or changed candidate metadata", async () => {
    const f = aggregateFixture();
    f.responses.set(f.release.assets.at(-1)!.browser_download_url, {
      status: 200,
      body: bytes({}),
    });
    await expect(
      sourceFromReleases([f.release], f.responses).fetch({
        name: "demo",
        version: { kind: "EXACT", value: "2.0.0" },
      }),
    ).resolves.toEqual({ kind: "INVALID" });
  });
  it("fails closed for two candidate sets offering the same exact package", async () => {
    const a = aggregateFixture(),
      b = aggregateFixture("crystra-workflow-package-v0.1.0-rc.2");
    await expect(
      sourceFromReleases(
        [a.release, b.release],
        new Map([...a.responses, ...b.responses]),
      ).fetch({ name: "demo", version: { kind: "EXACT", value: "2.0.0" } }),
    ).resolves.toEqual({ kind: "INVALID" });
  });
  it("uses the scoped release when present without consulting candidate receipts", async () => {
    const a = aggregateFixture(),
      stable = packageRelease({ name: "demo", version: "2.0.0" });
    await expect(
      sourceFromReleases([a.release, stable.release], stable.responses).fetch({
        name: "demo",
        version: { kind: "EXACT", value: "2.0.0" },
      }),
    ).resolves.toMatchObject({ kind: "FOUND" });
  });
});

describe("aggregate RC trust boundaries", () => {
  const mutations: [string, (manifest: ReturnType<typeof JSON.parse>) => void][] = [
    ["wrong repository", m => {m.repository="other/repository";}],
    ["invalid source revision", m => {m.revision="branch-main";}],
    ["missing contract", m => {m.contract=null;}],
    ["invalid contract revision", m => {m.contract.revision="latest";}],
    ["invalid package set", m => {m.packages=null;}],
    ["duplicate exact packages", m => {m.packages.push(m.packages[0]);}],
    ["wrong scoped package tag", m => {m.packages[0].tag="other";}],
    ["invalid content digest", m => {m.packages[0].package.digest="changed";}],
    ["missing declared asset", m => {m.packages[0].assets.pop();}],
    ["malformed asset entry", m => {m.packages[0].assets[0]=null;}],
    ["duplicate declared asset", m => {m.packages[0].assets[1]=m.packages[0].assets[0];}],
    ["unpublished declared asset", m => {m.packages[0].assets[0].name="absent.tar.gz";}],
  ];
  it.each(mutations)("rejects %s even when the receipt hashes that metadata", async(_name, mutate)=>{
    const f=aggregateFixture();
    const metadataUrl=f.release.assets.at(-2)!.browser_download_url;
    const receiptUrl=f.release.assets.at(-1)!.browser_download_url;
    const m=JSON.parse(Buffer.from(f.responses.get(metadataUrl)!.body).toString());mutate(m);
    const raw=bytes(m), q=JSON.parse(Buffer.from(f.responses.get(receiptUrl)!.body).toString());q.artifactMetadataSha256=sha256(raw);
    f.responses.set(metadataUrl,{status:200,body:raw});f.responses.set(receiptUrl,{status:200,body:bytes(q)});
    await expect(sourceFromReleases([f.release],f.responses).fetch({name:"demo",version:{kind:"EXACT",value:"2.0.0"}})).resolves.toEqual({kind:"INVALID"});
  });
  it("reports an unavailable receipt without accepting the package",async()=>{
    const f=aggregateFixture();f.responses.delete(f.release.assets.at(-1)!.browser_download_url);
    await expect(sourceFromReleases([f.release],f.responses).fetch({name:"demo",version:{kind:"EXACT",value:"2.0.0"}})).resolves.toEqual({kind:"UNAVAILABLE"});
  });
  it("rejects a changed descriptor despite an internally consistent archive checksum",async()=>{
    const f=aggregateFixture(),url=f.release.assets.find(a=>a.name==='workflow-package-demo-2.0.0.json')!.browser_download_url;
    f.responses.set(url,{status:200,body:Buffer.concat([f.responses.get(url)!.body,Buffer.from(' ')])});
    await expect(sourceFromReleases([f.release],f.responses).fetch({name:"demo",version:{kind:"EXACT",value:"2.0.0"}})).resolves.toEqual({kind:"DIGEST_MISMATCH"});
  });
});

it("does not resolve an unrelated package from a qualified aggregate", async()=>{
  const f=aggregateFixture();
  await expect(sourceFromReleases([f.release],f.responses).fetch({name:"another-package",version:{kind:"EXACT",value:"2.0.0"}})).resolves.toEqual({kind:"NOT_FOUND"});
});
it("rejects an aggregate that omits its qualification asset", async()=>{
  const f=aggregateFixture();f.release.assets.pop();
  await expect(sourceFromReleases([f.release],f.responses).fetch({name:"demo",version:{kind:"EXACT",value:"2.0.0"}})).resolves.toEqual({kind:"INVALID"});
});
it("bounds aggregate metadata before parsing it", async()=>{
  const f=aggregateFixture(),url=f.release.assets.at(-2)!.browser_download_url;
  f.responses.set(url,{status:200,body:new Uint8Array(2_097_153)});
  await expect(sourceFromReleases([f.release],f.responses).fetch({name:"demo",version:{kind:"EXACT",value:"2.0.0"}})).resolves.toEqual({kind:"INVALID"});
});
