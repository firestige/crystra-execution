import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { x } from "tar";
import { describe, expect, it } from "vitest";
import { qualifyDshInteractiveIntake } from "../../scripts/qualify-dsh-interactive-intake.js";
import type * as Execution from "../../src/index.js";

const repository = path.resolve(import.meta.dirname, "../..");

describe("DSH 0.1.5 packaged Execution qualification", () => {
  it("refuses to qualify the retired private browser plugin as the current product", async () => {
    await expect(qualifyDshInteractiveIntake({ coreArchive: "unused", pluginArchive: "unused" }))
      .rejects.toThrow("DSH_PRIVATE_INTAKE_QUALIFICATION_RETIRED");
  });

  it("packs, loads and restores the shipped provider against the real rc.2 runtime", async () => {
    // Keep the extracted artifact beneath the checkout so its optional peer resolves
    // through the same frozen dependency graph used by CI, without a source alias.
    const root = await mkdtemp(path.join(repository, ".crystra-inputs/dsh-artifact-"));
    const authorizations: string[] = [];
    const server = createServer((request, response) => {
      authorizations.push(request.headers.authorization ?? "");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "complete-1", type: "function", function: { name: "workflow_complete", arguments: '{"result":{"accepted":true}}' } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
    });
    let lease: Awaited<ReturnType<Execution.AgentProviderRealmFactory["acquire"]>> | undefined;
    try {
      execFileSync("pnpm", ["build"], { cwd: repository, stdio: "pipe" });
      const archive = execFileSync("npm", ["pack", "--silent", "--pack-destination", root], {
        cwd: repository, encoding: "utf8", env: { ...process.env, CRYSTRA_RELEASE_PACK_MODE: "verified-builder" },
      }).trim().split("\n").at(-1)!;
      await x({ file: path.join(root, archive), cwd: root });
      const artifact: typeof Execution = await import(pathToFileURL(path.join(root, "package/dist/index.js")).href);
      expect(artifact.DSH_RUNTIME_VERSION).toBe("0.1.5-rc.2");
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("test endpoint missing");
      const workspace = path.join(root, "workspace");
      await mkdir(workspace);
      const instructions = "Complete with workflow_complete";
      const instructionsPath = path.join(root, "instructions.md");
      await writeFile(instructionsPath, instructions);
      const credentialPath = path.join(root, "credentials.yml");
      await writeFile(credentialPath, "version: 1\nrefs:\n  CRYSTRA_ARTIFACT_QUALIFICATION_KEY: artifact-test-key\n");
      const factory = artifact.createDshAgentProviderFactory({
        stateDirectory: path.join(root, "sessions"), credentialPath,
        credentialRef: "CRYSTRA_ARTIFACT_QUALIFICATION_KEY", baseURL: `http://127.0.0.1:${address.port}`, turnTimeoutMs: 5000,
      });
      const descriptor = new artifact.AgentProviderFactoryRegistry([factory]).admit(
        { identity: "provider.dsh", version: "0.1.5-rc.2" }, ["structured-completion"],
      );
      const manifestBindingIdentity = `sha256:${"a".repeat(64)}`;
      const realm = {
        schemaVersion: "execution.agent-provider-delivery-realm-request@2.0.0" as const,
        deliveryId: "artifact-delivery", manifestBindingIdentity, canonicalWorktree: await realpath(workspace),
        providerIdentity: descriptor.identity, providerVersion: descriptor.version,
        providerDescriptorDigest: descriptor.descriptorDigest, maxParallelToolCalls: 1,
        roleBindings: [{ roleId: "role.test", modelProviderId: "deepseek", modelId: "deepseek-chat" }],
      };
      const instruction = { resourceIdentity: "role.test", localReadOnlyPath: instructionsPath, contentIdentity: `sha256:${createHash("sha256").update(instructions).digest("hex")}` };
      const request = {
        signal: new AbortController().signal,
        dispatch: {
          episode: { thread: { delivery: { deliveryIdentity: realm.deliveryId, manifestBindingIdentity } } },
          action: { identity: "action.test", purpose: "complete", resultSchema: { type: "object" } },
          workspace: { kind: "none" },
          executor: { sessionCompatibilityIdentity: "artifact-compatibility", session: {
            roleIdentity: "role.test", routeIdentity: "route.test", agent: instruction, instructions: instruction,
            skills: [], tools: [], providedCapabilities: ["structured-completion"],
            model: { providerModelIdentity: "deepseek-chat" }, driver: { providerIdentity: "dsh-headless", configuration: {} },
          } },
        } as never,
      };
      lease = await factory.acquire(realm);
      const session = await lease.adapter.sessions.open(request);
      const opaqueIdentity = session.opaqueIdentity;
      expect(await session.run("complete")).toContainEqual({ kind: "structured-completion", result: { accepted: true } });
      await session.persist();
      await lease.dispose();
      lease = await factory.acquire(realm);
      const restored = await lease.adapter.sessions.restore({ ...request, opaqueIdentity });
      expect(restored.opaqueIdentity).toBe(opaqueIdentity);
      expect(await restored.run("complete again")).toContainEqual({ kind: "structured-completion", result: { accepted: true } });
      expect(authorizations).toEqual(["Bearer artifact-test-key", "Bearer artifact-test-key"]);
    } finally {
      await lease?.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
