import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDshAgentProviderFactory } from "../../../src/index.js";

import { AgentProviderFactoryRegistry } from "../../../src/providers/provider.js";
import { createDefaultProductionAgentProviderFactories } from "../../../src/composition/agent-provider-production.js";

const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function dispatch(instructionsPath: string) {
  const instructions = "complete with the structured completion tool";
  return {
    instructions,
    value: {
      episode: { thread: { delivery: { deliveryIdentity: "delivery-1", manifestBindingIdentity: `sha256:${"a".repeat(64)}` } } },
      action: { identity: "action.test", purpose: "complete", resultSchema: { type: "object" } },
      workspace: { kind: "none" },
      executor: {
        sessionCompatibilityIdentity: "compatibility-1",
        session: {
          roleIdentity: "role.test", routeIdentity: "route.test",
          agent: {
            resourceIdentity: "role.test",
            localReadOnlyPath: instructionsPath,
            contentIdentity: `sha256:${createHash("sha256").update(instructions).digest("hex")}`,
          },
          skills: [],
          tools: [],
          providedCapabilities: ["structured-completion", "action-interaction"],
          instructions: {
            resourceIdentity: "role.test",
            localReadOnlyPath: instructionsPath,
            contentIdentity: `sha256:${createHash("sha256").update(instructions).digest("hex")}`,
          },
          model: { providerModelIdentity: "deepseek-chat" },
          driver: {
            providerIdentity: "dsh-headless",
            configuration: {},
          },
        },
      },
    } as never,
  };
}

describe("DSH production Agent Provider", () => {
  it("registers DSH in the default production provider set without starting it", () => {
    const factories = createDefaultProductionAgentProviderFactories({ stateRoot: "/tmp/crystra", startupTimeoutMs: 1000, executionTimeoutMs: 1000, shutdownTimeoutMs: 1000 });
    expect(new AgentProviderFactoryRegistry(factories).admit({ identity: "provider.dsh", version: "0.1.5-rc.2" }, ["structured-completion"])).toMatchObject({ adapterKey: "dsh-headless" });
  });
  it.each([
    { stateDirectory: "relative" },
    { stateDirectory: "/tmp/dsh", credentialPath: "relative" },
    { stateDirectory: "/tmp/dsh", credentialRef: "BAD KEY" },
    { stateDirectory: "/tmp/dsh", baseURL: "file:///tmp/key" },
    { stateDirectory: "/tmp/dsh", turnTimeoutMs: 0 },
    { stateDirectory: "/tmp/dsh", modelQueryTimeoutMs: 0 },
  ])("rejects invalid local settings: %j", (options) => {
    expect(() => createDshAgentProviderFactory(options)).toThrow();
  });
  it.each(["environment", "file", "input", "timeout", "cancel", "error", "missing"])("runs an isolated real DSH realm: %s", async (source) => {
    const observedAuthorization: string[] = [];
    const server = createServer((request, response) => {
      observedAuthorization.push(request.headers.authorization ?? "");
      if (source === "timeout" || source === "cancel") return;
      if (source === "error") { response.writeHead(401); response.end('{"error":{"message":"denied"}}'); return; }
      if (source === "input") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "input-1", type: "function", function: { name: "workflow_request_input", arguments: JSON.stringify({ requestIdentity: "question-1", prompt: "Continue?" }) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        'data: {"id":"completion-1","object":"chat.completion.chunk","created":1,"model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"workflow_complete","arguments":"{\\"result\\":{\\"accepted\\":true}}"}}]},"finish_reason":"tool_calls"}]}',
        "",
        "data: [DONE]",
        "",
        "",
      ].join("\n"));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new TypeError("test server did not bind");

    const root = await mkdtemp(join(tmpdir(), "dsh-adapter-factory-real-"));
    roots.push(root);
    const workspaceDirectory = join(root, "workspace");
    const credentialPath = join(root, "credentials.yml");
    const instructionsPath = join(root, "instructions.md");
    await mkdir(workspaceDirectory);
    await writeFile(credentialPath, "version: 1\nrefs:\n  EXACT_FACTORY_KEY: configured-file-secret\n", "utf8");
    await chmod(credentialPath, 0o600);
    if (source === "missing") await rm(credentialPath);
    const fixture = dispatch(instructionsPath);
    await writeFile(instructionsPath, fixture.instructions, "utf8");
    const previous = process.env.EXACT_FACTORY_KEY;
    if (source === "environment") process.env.EXACT_FACTORY_KEY = "ambient-secret";
    else delete process.env.EXACT_FACTORY_KEY;
    try {
      const factory = createDshAgentProviderFactory({
        stateDirectory: join(root, "sessions"), credentialPath,
        turnTimeoutMs: source === "timeout" ? 30 : 5000,
        credentialRef: "EXACT_FACTORY_KEY", baseURL: `http://127.0.0.1:${address.port}`,
      });
      const descriptor = new AgentProviderFactoryRegistry([factory]).admit({ identity: "provider.dsh", version: "0.1.5-rc.2" }, ["structured-completion"]);
      const realmRequest = {
        schemaVersion: "execution.agent-provider-delivery-realm-request@2.0.0" as const,
        deliveryId: "delivery-1", manifestBindingIdentity: `sha256:${"a".repeat(64)}`,
        canonicalWorktree: await realpath(workspaceDirectory),
        providerIdentity: descriptor.identity, providerVersion: descriptor.version,
        providerDescriptorDigest: descriptor.descriptorDigest, maxParallelToolCalls: 1,
        roleBindings: [{ roleId: "role.test", modelProviderId: "deepseek", modelId: "deepseek-chat" }],
      };
      await expect(factory.acquire({ ...realmRequest, providerDescriptorDigest: `sha256:${"0".repeat(64)}` })).rejects.toThrow("realm request");
      await expect(factory.acquire({ ...realmRequest, roleBindings: [...realmRequest.roleBindings, ...realmRequest.roleBindings] })).rejects.toThrow("Role binding");
      await expect(factory.acquire({ ...realmRequest, roleBindings: [{ roleId: "role.test", modelProviderId: "other", modelId: "deepseek-chat" }] })).rejects.toThrow("Role binding");
      const lease = await factory.acquire(realmRequest);
      const adapter = lease.adapter;
      const request = { dispatch: fixture.value, signal: new AbortController().signal };
      const altered = structuredClone(request.dispatch) as any;
      altered.executor.session.model.providerModelIdentity = "other-model";
      await expect(adapter.sessions.open({ ...request, dispatch: altered })).rejects.toThrow("frozen Delivery binding");
      altered.executor.session.model.providerModelIdentity = "deepseek-chat";
      altered.episode.thread.delivery.deliveryIdentity = "delivery-other";
      await expect(adapter.sessions.open({ ...request, dispatch: altered })).rejects.toThrow("frozen Delivery binding");
      await expect(adapter.sessions.open({ ...request, signal: AbortSignal.abort() })).rejects.toThrow();
      if (source === "missing") {
        await expect(adapter.sessions.open(request)).rejects.toThrow("credential is unavailable");
        await lease.dispose();
        return;
      }
      const session = await adapter.sessions.open(request);
      const opaqueIdentity = session.opaqueIdentity;
      if (["input", "timeout", "cancel", "error"].includes(source)) {
        const running = session.run({ task: "complete" });
        if (source === "cancel" || source === "timeout") {
          await expect(session.run({})).rejects.toThrow("active turn");
        }
        if (source === "cancel") await session.cancel();
        const events = await running;
        if (source === "input") expect(events).toContainEqual({ kind: "input-request", requestIdentity: "question-1", prompt: "Continue?", responseSchema: { type: "string" } });
        else expect(events).toContainEqual(expect.objectContaining({ kind: "provider-failed", code: source === "timeout" ? "PROVIDER_TIMED_OUT" : source === "cancel" ? "PROVIDER_CANCELLED" : "PROVIDER_PROTOCOL_ERROR" }));
        if (source === "timeout") await expect(session.run({})).rejects.toThrow("timed out");
        await lease.dispose();
        return;
      }
      expect(await session.run({ task: "complete" })).toContainEqual({ kind: "structured-completion", result: { accepted: true } });
      await session.persist();
      await session.dispose();
      await session.dispose();
      await expect(session.run({})).rejects.toThrow("disposed");
      await lease.dispose();
      const recovered = await factory.acquire(realmRequest);
      const incompatible = structuredClone(request.dispatch) as any;
      incompatible.executor.session.routeIdentity = "route.other";
      await expect(recovered.adapter.sessions.restore({ ...request, dispatch: incompatible, opaqueIdentity })).rejects.toThrow("incompatible");
      await expect(recovered.adapter.sessions.restore({ ...request, opaqueIdentity: "session-unknown" })).rejects.toThrow();
      const restored = await recovered.adapter.sessions.restore({ ...request, opaqueIdentity });
      expect(restored.opaqueIdentity).toBe(opaqueIdentity);
      expect(await restored.run({ task: "complete again" })).toContainEqual({ kind: "structured-completion", result: { accepted: true } });
      expect(observedAuthorization).toEqual(Array(2).fill(source === "environment" ? "Bearer ambient-secret" : "Bearer configured-file-secret"));
      await restored.cancel();
      await recovered.dispose();
      await expect(recovered.adapter.sessions.open(request)).rejects.toThrow("disposed");
      await expect(restored.persist()).rejects.toThrow("disposed");
      await lease.dispose();
      await adapter.dispose();
    } finally {
      if (previous === undefined) delete process.env.EXACT_FACTORY_KEY;
      else process.env.EXACT_FACTORY_KEY = previous;
    }
  });
});
