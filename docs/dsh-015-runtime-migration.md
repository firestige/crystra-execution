# DSH 0.1.5-rc.2 runtime alignment

Execution's production `provider.dsh` descriptor, optional runtime peer, development
runtime, release compatibility metadata and active binding examples use
`0.1.5-rc.2`. The public host is `dsh-crystra` in `crystra-dsh`.

The adapter now uses `Session.ownEvents()`, mounts `SessionProjectionRegistry`
before `AgentLoop`, loads the JSONL persistence backend's default export, and
supplies the DeepSeek adapter's required request-extension transaction. Isolated
workflow operations admit no ambient request extensions. Credentials and exact
Delivery/session restoration retain the existing isolation boundary.

DSH's published packages use version ranges. The workspace overrides pin the
complete DSH component graph to rc.2 and the Cordis foundation to the versions
specified by that release; the frozen lockfile is the qualification input.
Without those overrides, installation selected rc.3 components and newer Cordis
HMR interfaces incompatible with the rc.2 launcher.

## Qualification ownership

Execution qualifies the actual npm-packed library against the real rc.2 runtime
and a local HTTP model-protocol fixture: structured completion, persistence,
realm disposal and restoration of the exact native session. Source-level runtime
regressions additionally exercise credentials, input suspension, timeout,
cancellation, errors and signed filesystem access. This does not claim a live
DeepSeek service or product browser end-to-end acceptance.

The old automated browser test packaged `crystra-execution-intake-internal`, a
retired private fixture using the removed `conversationEvents` service and old
client API. It has been replaced by the packed-library runtime qualification;
its old executable qualifier now refuses to issue a PASS result. Browser
orchestration joins the other product browser scripts outside unit coverage.
The private fixture's pure regression tests and historical compatibility metadata
remain unchanged. Product browser qualification belongs to the current host's
`qualify:real-harness` flow in `crystra-dsh`; it is not executed by this component
migration and is not claimed to pass here.

Existing immutable Deliveries keep their original provider descriptor. They must
use their matching runtime to recover; newly admitted Deliveries must bind
`provider.dsh@0.1.5-rc.2`. No release request, published historical candidate or
superproject component pointer changes as part of this migration.
