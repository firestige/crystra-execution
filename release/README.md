# Crystra Execution release adapter

The core is distributed as an ordinary, exact GitHub Release tarball dependency. The only public DSH plugin, `dsh-crystra`, is owned by `firestige/crystra-dsh`.

Local artifact checks (these do not publish):

```sh
pnpm release:config:verify
pnpm release:matrix:verify
pnpm release:check-coordinates
pnpm release:simulate happy
pnpm release:artifacts <directory>
pnpm release:verify <directory>
```

Pushing `release/next` starts candidate qualification from the committed `release/request.json`. The component checks out its own SHA and the exact development inputs listed in `config/development-inputs.json`, runs its regression and build gates, and builds `crystra-execution-<version>.tgz`. Candidate tags use `crystra-execution-v<version>-rc.N`.

Stable promotion is a human release gate. It verifies and reuses the qualified bytes for the final GitHub Release, using a repository-scoped GitHub App token. Neither candidate publication nor promotion publishes to npm. Historical npm tooling is not part of this release path.
