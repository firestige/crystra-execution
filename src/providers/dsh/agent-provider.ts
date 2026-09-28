import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { InvocationDispatch } from "../../contracts/index.js";
import { canonicalDigest } from "../../contracts/index.js";
import type {
  AgentProviderRealmFactory, AgentProviderSessionOpenRequest,
  AgentProviderDeliveryRealmRequest, NativeProviderSession, NativeTurnEvent,
} from "../provider.js";
import { DshProviderAdapterFactory } from "./adapter-factory.js";

export const DSH_PROVIDER_IDENTITY = "provider.dsh";
export const DSH_RUNTIME_VERSION = "0.1.1-rc.2";

/** Provider-local connection settings; never part of a Delivery or credential envelope. */
export interface DshAgentProviderFactoryOptions {
  readonly stateDirectory: string;
  readonly credentialPath?: string;
  readonly credentialRef?: string;
  readonly baseURL?: string;
  readonly turnTimeoutMs?: number;
}

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function createDshAgentProviderFactory(options: DshAgentProviderFactoryOptions): AgentProviderRealmFactory {
  const stateDirectory = options.stateDirectory;
  const credentialPath = options.credentialPath ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), ".credentials.yaml");
  const credentialRef = options.credentialRef ?? "DEEPSEEK_API_KEY";
  const baseURL = options.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
  const turnTimeoutMs = options.turnTimeoutMs ?? 7_200_000;
  if (!isAbsolute(stateDirectory) || !isAbsolute(credentialPath) || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(credentialRef)
    || !Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs < 1 || turnTimeoutMs > 2_147_483_647
    || !["http:", "https:"].includes(new URL(baseURL).protocol)) throw new TypeError("DSH Provider configuration is invalid");
  const descriptor = Object.freeze({
    schemaVersion: "execution.agent-provider-factory@1.0.0" as const,
    identity: DSH_PROVIDER_IDENTITY, version: DSH_RUNTIME_VERSION, adapterKey: "dsh-headless" as const,
    capabilities: Object.freeze(["action-interaction", "structured-completion"]),
  });
  return Object.freeze({ descriptor, async acquire(request: AgentProviderDeliveryRealmRequest) {
    if (request.schemaVersion !== "execution.agent-provider-delivery-realm-request@2.0.0"
      || request.providerIdentity !== descriptor.identity || request.providerVersion !== descriptor.version
      || request.providerDescriptorDigest !== canonicalDigest(descriptor)
      || !/^sha256:[a-f0-9]{64}$/u.test(request.manifestBindingIdentity) || !request.deliveryId
      || !isAbsolute(request.canonicalWorktree) || await realpath(request.canonicalWorktree) !== request.canonicalWorktree
      || !Number.isSafeInteger(request.maxParallelToolCalls) || request.maxParallelToolCalls < 1
      || request.roleBindings.length === 0) throw new TypeError("DSH Delivery realm request is invalid");
    const roles = new Map<string, { modelProviderId: string; modelId: string }>();
    for (const role of request.roleBindings) {
      if (!role.roleId || roles.has(role.roleId) || !["deepseek", "deepseek-official"].includes(role.modelProviderId)
        || !role.modelId.trim()) throw new TypeError("DSH Role binding is invalid");
      roles.set(role.roleId, { modelProviderId: role.modelProviderId, modelId: role.modelId });
    }
    const deliveryId = request.deliveryId;
    const manifestBindingIdentity = request.manifestBindingIdentity;
    const directory = join(stateDirectory, hash([deliveryId, manifestBindingIdentity, request.canonicalWorktree]));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const native = await new DshProviderAdapterFactory().create({
      providerIdentity: "dsh-headless", workspaceDirectory: request.canonicalWorktree,
      sessionStorageDirectory: join(directory, "sessions"), credentialStore: { path: credentialPath, watch: false },
      maxParallelToolCalls: request.maxParallelToolCalls,
    });
    let disposed = false;
    const live = new Set<NativeProviderSession>();
    const pending = new Set<Promise<NativeProviderSession>>();
    const assertLive = () => { if (disposed) throw new TypeError("DSH Delivery realm is disposed"); };
    const open = async (input: AgentProviderSessionOpenRequest, opaqueIdentity?: string): Promise<NativeProviderSession> => {
      assertLive();
      input.signal.throwIfAborted();
      const dispatch = input.dispatch;
      const role = roles.get(dispatch.executor.session.roleIdentity);
      if (dispatch.executor.session.driver.providerIdentity !== "dsh-headless"
        || dispatch.episode.thread.delivery.deliveryIdentity !== deliveryId
        || dispatch.episode.thread.delivery.manifestBindingIdentity !== manifestBindingIdentity
        || role === undefined || role.modelId !== dispatch.executor.session.model.providerModelIdentity) {
        throw new TypeError("DSH dispatch does not match the frozen Delivery binding");
      }
      const binding = hash([dispatch.executor.sessionCompatibilityIdentity, dispatch.session, dispatch.executor.session, role, baseURL, credentialRef]);
      const recordPath = (identity: string) => join(directory, `${hash(identity)}.json`);
      if (opaqueIdentity !== undefined) {
        const record = JSON.parse(await readFile(recordPath(opaqueIdentity), "utf8"));
        if (record.opaqueIdentity !== opaqueIdentity || record.binding !== binding) throw new TypeError("DSH session restore binding is incompatible");
      }
      // The 2.0 request has no credential fields. Adapt only inside this Provider.
      const projected: InvocationDispatch = {
        ...dispatch, executor: { ...dispatch.executor, session: { ...dispatch.executor.session,
          driver: { ...dispatch.executor.session.driver, configuration: { providerRoute: role.modelProviderId, credentialRef, baseURL } },
        } },
      };
      const environmentKey = process.env[credentialRef];
      const credentials = environmentKey ? { material: { apiKey: environmentKey }, async release() { this.material.apiKey = ""; } }
        : await native.credentials.acquire(projected);
      let session: NativeProviderSession;
      try {
        const nativeRequest = { dispatch: projected, credentials: credentials.material, signal: input.signal };
        session = opaqueIdentity === undefined ? await native.sessions.open(nativeRequest)
          : await native.sessions.restore({ ...nativeRequest, opaqueIdentity });
      } catch (error) { await credentials.release(); throw error; }
      let closed = false;
      let running = false;
      let timedOut = false;
      const wrapper: NativeProviderSession = {
        opaqueIdentity: session.opaqueIdentity,
        async run(value): Promise<readonly NativeTurnEvent[]> {
          assertLive();
          if (closed || timedOut) throw new TypeError("DSH session is disposed or timed out");
          if (running) throw new TypeError("DSH session already has an active turn");
          running = true;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              session.run({ kind: "CRYSTRA_AGENT_ACTION", action: dispatch.action, input: value }),
              new Promise<readonly NativeTurnEvent[]>((resolve) => {
                timer = setTimeout(() => {
                  timedOut = true;
                  void session.cancel().catch(() => undefined);
                  resolve([{ kind: "provider-failed", code: "PROVIDER_TIMED_OUT", detail: "DSH turn timed out" }]);
                }, turnTimeoutMs);
              }),
            ]);
          } finally { running = false; if (timer !== undefined) clearTimeout(timer); }
        },
        async persist() {
          assertLive();
          if (closed) throw new TypeError("DSH session is disposed");
          await session.persist();
          await writeFile(recordPath(session.opaqueIdentity), JSON.stringify({ opaqueIdentity: session.opaqueIdentity, binding }), { mode: 0o600 });
        },
        async cancel() { if (!closed) await session.cancel(); },
        async dispose() {
          if (closed) return;
          closed = true;
          try { await session.dispose(); } finally { live.delete(wrapper); await credentials.release(); }
        },
      };
      live.add(wrapper);
      if (disposed || input.signal.aborted) {
        await wrapper.dispose();
        input.signal.throwIfAborted();
        assertLive();
      }
      return wrapper;
    };
    const track = (input: AgentProviderSessionOpenRequest, identity?: string) => {
      const operation = open(input, identity);
      pending.add(operation);
      void operation.then(() => pending.delete(operation), () => pending.delete(operation));
      return operation;
    };
    const adapter = Object.freeze({
      key: "dsh-headless" as const,
      sessions: Object.freeze({ open: (input: AgentProviderSessionOpenRequest) => track(input),
        restore: (input: AgentProviderSessionOpenRequest & { opaqueIdentity: string }) => track(input, input.opaqueIdentity) }),
      async dispose() {
        if (disposed) return;
        disposed = true;
        await Promise.allSettled([...pending]);
        try {
          const results = await Promise.allSettled([...live].map((session) => session.dispose()));
          const failure = results.find((result) => result.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        } finally { await native.dispose(); }
      },
    });
    return Object.freeze({
      schemaVersion: "execution.agent-provider-delivery-realm-lease@2.0.0" as const,
      providerIdentity: descriptor.identity, providerVersion: descriptor.version,
      descriptorDigest: request.providerDescriptorDigest, deliveryId, manifestBindingIdentity,
      adapter, dispose: () => adapter.dispose(),
    });
  } });
}
