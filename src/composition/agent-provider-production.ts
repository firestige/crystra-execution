import { createRequire } from "node:module";
import path from "node:path";

import { CodexCliProviderRealmFactory } from "../providers/codex/index.js";
import { createDshAgentProviderFactory } from "../providers/dsh/agent-provider.js";
import { createCopilotAgentProviderFactory } from "../providers/copilot/index.js";
export {
  AgentProviderFactoryRegistry,
  DeliveryAgentProviderRealmBroker,
  type AgentProviderRealmFactory,
  type ProviderModelCatalogEntry,
  type ProviderAdapterKey,
} from "../providers/provider.js";
import type { AgentProviderRealmFactory } from "../providers/provider.js";

export function createDefaultProductionAgentProviderFactories(config: Readonly<{
  stateRoot: string;
  startupTimeoutMs: number;
  executionTimeoutMs: number;
  shutdownTimeoutMs: number;
}>): readonly AgentProviderRealmFactory[] {
  return Object.freeze([
    createDshAgentProviderFactory({ stateDirectory: path.join(config.stateRoot, "providers", "dsh"), turnTimeoutMs: config.executionTimeoutMs, modelQueryTimeoutMs: config.startupTimeoutMs }),
    createCopilotAgentProviderFactory({ turnTimeoutMs: config.executionTimeoutMs }),
    new CodexCliProviderRealmFactory({
      executablePath: createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js"),
      requiredVersion: "0.144.5",
      stateDirectory: path.join(config.stateRoot, "providers", "codex"),
      startupTimeoutMs: config.startupTimeoutMs,
      executionTimeoutMs: config.executionTimeoutMs,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
    }),
  ]);
}
