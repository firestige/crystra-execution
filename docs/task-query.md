# Execution Task ownership and queries

Task identity belongs to Execution. Evidence holds analytical observations, not the
Task catalogue. A worktree's recoverable runtime is an execution instance; listing
Tasks neither starts nor recovers that runtime.

`TaskRepository` stores immutable, versioned Task headers under `<stateRoot>/tasks`.
Creation publishes a synced file with atomic no-overwrite linking. Identity collisions
fail instead of overwriting another worktree's Task. Task creation is independent of
Delivery success: once recorded during admission it remains if prompt capture,
binding, or runtime startup fails. REUSE_TASK must resolve an existing Task and keeps
its title. A Task completion/rename/delete command is not introduced in this change.

`TaskQuery.snapshot()` combines these headers with associations from validated durable
Delivery Manifests. This compatibility path retains pre-existing Tasks, including
terminal Deliveries, without reconstructing identity from runtime inventory or Evidence.
A Task header wins for title and creation time. Legacy-only Tasks have no inferred
creation time. `lastActivityAt` currently reflects Task creation and Delivery creation,
not per-action progress; no Task status is inferred from a Delivery outcome. Results
are immutable and deterministically ordered, with a content revision for reconciliation.
Corrupt records or inaccessible sources fail the query rather than yielding partial data.

`getExecutionTaskQuery(application)` exposes the production application's read seam.
`openExecutionTaskQuery(configFile)` mounts the same read query independently of runtime
activation, requiring readable durable storage rather than runnable worktrees. Neither
path opens recovery checkpoints or writes during reads. The durable root selects the
catalogue scope; distinct installation roots are distinct catalogues, not a machine-wide
implicit union.

Crystra-dsh exposes `/crystra-tasks/list` and `/crystra-tasks/changes` through its existing
loopback RPC host. `changes` accepts `{after: revision}` and returns a complete snapshot
when its revision differs or after a bounded wait. The initial implementation rechecks
the durable source once per second while waiting, so other processes' committed changes
are observable without adding a database watcher daemon. Clients reconnect from a full
snapshot and never infer missing incremental events. This is bounded long polling, not
the DSH Session event feed itself. Catalogue reads currently validate stored manifests;
a larger catalogue may require a revision cache/index without changing this contract.

The staged Crystra-dsh hook owns shared client state; Crystra-ui owns presentation only.
The Vite development host can mount this read seam without changing installed packages.
