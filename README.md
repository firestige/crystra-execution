# Crystra — Execution System

English | [中文](README.zh-CN.md)


[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![CI](https://github.com/firestige/crystra-execution/actions/workflows/ci.yml/badge.svg)](https://github.com/firestige/crystra-execution/actions)

**Turn every agent conversation into an auditable, recoverable, version-bound delivery.**

The Execution System is the host-neutral execution boundary of [crystra](https://github.com/firestige/crystra): it resolves and validates one *exact* Workflow Package, binds it in an *immutable* Delivery Manifest, coordinates the Delivery inside an isolated Runner-owned execution context, recovers from the last durable boundary after crashes, and emits *bounded* observations over OTLP — observation never controls execution.

## Delivery forms (交付形态)

The Execution System is a host-neutral product, not a plugin. DSH is one entry point among several:

| Form | Package | Audience |
|---|---|---|
| **Embedded library** | `crystra-execution` | Host-neutral embedding — import `ExecutionApplicationFactory` and bootstrap with `create(configFile, dependencies)` |
| **DSH plugin entry** | `dsh-crystra` | DeepSeek Harness users — run workflows from chat and sidebar tabs |
| **CLI** | `execution-config` (in `crystra-execution`) | Configuration init / copy / validate / dump-effective |

The DSH plugin is the first product entry; every admitted Workflow Action runs in a Runner-owned, isolated DSH execution context (`DSH-E`), never in the Intake context (`DSH-I`).

## Why it exists

| Bare agent chat | What actually happens | Execution System |
|---|---|---|
| Execution is a black box | What the model did, and with which workflow definition, cannot be audited afterwards | Every Delivery binds one exact version + SHA-256 into an immutable Manifest |
| Interruptions lose state | After a crash or restart there is nowhere to look | Manifest/current-slot persist; `/crystra recover` resumes from the last durable boundary |
| Version drift | The same request can execute different definitions at different times | Exact `name@version` selectors, immutable GitHub assets, and a validated exact-content READY cache |
| Observation couples to execution | A telemetry outage can take the run down with it | One-way, best-effort OTLP; Execution continues when Evidence or telemetry is unavailable |

## How it works

Three modules carry the responsibility:

- **Delivery Binding** resolves one exact, locally `READY` Workflow Package (selector → validation → local `MISSING/STAGING/READY` store) and constructs the Manifest content.
- **Runtime Interaction** owns canonical worktree exclusivity, the current Delivery slot, Manifest persistence, Runtime invocation, recovery, and final handling.
- **Delivery Observation** maps outbound bounded facts to a one-way, best-effort OTLP profile without controlling execution.

The default Source is the configured `firestige/crystra-workflow-package` GitHub Release. `implementation-workflow@0.3.0` and `system-design-workflow@0.3.0` are downloaded, validated, and published to the local READY store; neither is embedded in an Execution artifact.

![Architecture](docs/assets/architecture.png)


## Installation

The only public DSH plugin is `dsh-crystra`, owned and registered by [firestige/crystra-dsh](https://github.com/firestige/crystra-dsh). Its release pins this core as an ordinary, exact GitHub Release tarball dependency. Follow that repository for plugin installation and setup; no separate Execution plugin or installer is distributed.

Crystra candidates are being prepared; no Crystra release is available yet. `packages/dsh-intake` is a private regression fixture pending consolidation into that plugin.

## Commands

```text
/crystra list                         # privacy-safe Delivery and worktree state
/crystra create <name|name@latest|name@version>
/crystra recover [delivery-id]
/crystra status [delivery-id]
/crystra action finish
/crystra abandon [delivery-id]
```

The explicit first-party skill `/workflow-execution` performs exactly one closed operation through the DSH-I-only `workflow_execution_intake` tool.

## Compatibility

| Dimension | Requirement |
|---|---|
| Node.js | `>=24.12.0 <25` |
| DeepSeek Harness | `0.1.1-rc.2` (`@deepseek-ai/dsh`) |
| Workflow Package contract | `agentops.workflow-dsl@2.0.0` |
| Observation contract | `agentops.observation@1.0.0` |
| Checkpoint store | `better-sqlite3` (native build, approved via `allowBuilds`) |

## Known Limitations and Deferred Work

- **Developer preview** — version `0.1.x` is intended for trusted local use by individuals and small teams; compatibility-breaking changes are possible.
- **Exclusive Session/Delivery binding** — the DSH Intake passes a private, typed, invocation-only proof of the exact registered conversation workspace; Execution derives and persists the canonical Git worktree, while Manifest/current-slot remain the durable Delivery/worktree authority. One Session, Delivery, and occupied worktree cannot be implicitly switched, shared, stolen, or released by timeout.
- **Observation disabled by default** — set `observation.enabled: true` with a loopback OTLP base `endpoint` to enable the non-controlling exporter.
- **DSH-only interactive surface** — the shipped `web` profile is the reference assembly; a custom profile contains only `dsh-base` and is not an interactive Intake surface.

## For maintainers

- **Release qualification** — see [the release process](https://github.com/firestige/crystra/blob/main/docs/guides/execution-release-process.md). This repository qualifies the host-neutral core; DSH bundle and clean-profile qualification are owned by [firestige/crystra-dsh](https://github.com/firestige/crystra-dsh).
- **Local pre-release E2E** — [guide](https://github.com/firestige/crystra/blob/main/docs/guides/dsh-execution-local-e2e.md); final [DSH quickstart](https://github.com/firestige/crystra/blob/main/docs/guides/dsh-execution-quickstart.md); [configuration reference](https://github.com/firestige/crystra/blob/main/docs/reference/execution-configuration.md); [DSH Intake package reference](packages/dsh-intake/README.md).

### Direct embedding

For host-neutral embedding, import `ExecutionApplicationFactory`, `DefaultExecutionApplicationFactory`, `ExecutionRequest`, `TaskPrompt`, and the configuration types from the package root. Calling the default factory's `create(configFile, dependencies)` is the single production bootstrap path. The exact DSH runtime is an optional peer: package-root import/type consumers need not install it, while executing the current `dsh` Provider requires the embedding profile to provide `@deepseek-ai/dsh@0.1.1-rc.2`. The release includes `config/schema/execution.config.schema.json`, versioned defaults/examples, compiled TypeScript declarations, and `execution-config init|copy|validate|dump-effective`.

## Multi-Provider 2.0

`execution.config@2.0.0` is the production multi-Provider path and contains no installation-wide Provider or model default. `DefaultExecutionApplicationFactory` registers the exact bundled Copilot SDK and Codex CLI Provider factories unless an embedding supplies an explicit registry. Each Agent-action Role must be present in `<canonical-worktree>/.crystra/role-provider-bindings.json` with an exact Provider identity/version and Provider-owned model coordinate. Admission validates required Workflow capabilities, freezes the factory descriptor digest into `execution.delivery-manifest@2.0.0`, and never performs priority selection or fallback. Recovery accepts only the same descriptor and starts realms only for Providers actually used by the persisted Delivery. See `config/schema/execution.config.v2.schema.json`.

The default Copilot factory registers `provider.copilot@1.0.78` and reuses the local logged-in user through the exact bundled SDK. The default Codex factory registers `provider.codex@0.144.5` and reuses Codex CLI's local login state. Neither path asks the embedding host for token material. Every Delivery realm admits only model coordinates frozen for its Roles and fails closed on runtime, login, model, recovery, or binding drift.

## Get the source

This repository is normally consumed as a submodule of [crystra](https://github.com/firestige/crystra):

```sh
git clone --recurse-submodules https://github.com/firestige/crystra.git
```

To clone it standalone:

```sh
git clone https://github.com/firestige/crystra-execution.git
```

## Documentation

- [Execution System design](https://github.com/firestige/crystra/blob/main/docs/systems/execution/project-execution-system.md)
- [Conceptual architecture](https://github.com/firestige/crystra/blob/main/docs/agent-architecture.md)
- [Workflow composition model](https://github.com/firestige/crystra/blob/main/docs/workflow-composition-model.md)
- [Execution–Evidence interaction contract](https://github.com/firestige/crystra/blob/main/docs/contracts/execution-evidence/interaction-contract.md)
- [Planned first-party LangGraph runtime profile](https://github.com/firestige/crystra/blob/main/docs/systems/runtime/first-party-langgraph-runtime-profile.md)

## License

[Apache-2.0](LICENSE)
