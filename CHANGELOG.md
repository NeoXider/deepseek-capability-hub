# Changelog

All notable changes to DeepSeek Capability Hub are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-08-27

### Fixed

- **Nothing capped the size of a model-facing reply.** Row limits were in place but field
  limits were not, and the schema permits a 2,000-character description with 100 tags of
  500 characters each — 50 search rows measured 2.6 MB. A `call` result went through
  untouched; one measured 8.4 MB, roughly two million tokens, returned by the very tool
  whose purpose is a small context. Descriptions and tags are now truncated, tool
  descriptions with them, and a call result is capped with a `truncated` flag rather than
  silently cut.
- **A streamable-http entry could name any scheme and follow any redirect.** `z.url()`
  accepts `file://` and plain http to an internal host, and the transport followed
  redirects, so a compromised endpoint could bounce a request — along with any
  non-Authorization header from `headersFromEnv` — into a service on the host's private
  network. Encrypted transport is now required except on loopback, redirects are refused,
  and a resolved URL whose origin no longer matches the catalog entry is rejected.

## [0.3.0] - 2026-08-27

An audit pass. Two of these were incomplete fixes from the previous release, not new
defects — the earlier work closed one door and left the adjacent one open.

### Fixed

- **A catalog entry could load arbitrary code into a child process.** The previous
  release blocked `${config:...}` in `transport.command` but left `transport.env`
  untouched, and the guard's own error message told operators to "put configurable values
  in args or env". A model-supplied value reaching `NODE_OPTIONS`, `LD_PRELOAD`,
  `PYTHONSTARTUP` and similar runs before the server's entry point. Those names are now
  refused outright, `cwd` no longer interpolates configuration, and the error text no
  longer points at the hole.
- **Any failed call tore down a healthy child.** The previous release turned every
  rejection into "the server stopped responding", closed the client and killed the
  process — including a cancelled call and a local serialisation error the child never
  saw. Cancellation, a rejected request and a genuinely broken pipe are now told apart,
  and only the last one restarts anything.
- **The hub and its children never exited when the host closed stdin.** The stdio
  transport does not listen for end-of-input, so shutdown never ran. With no capability
  running the process happened to exit anyway; with one live child it lingered forever,
  leaving another orphan on every host restart. On Windows this was the only reachable
  exit path at all, because SIGTERM there terminates without running a handler. Shutdown
  now also races a five-second deadline so a child hung in `initialize` cannot hold it.
- **The approval queue had no quota.** Nothing capped the pending directory or rejected a
  repeated name: 200 proposals wrote 163 MiB in two seconds, and `proposals` then returned
  all of them in full — a 170 MB reply to a model whose entire purpose is a small context.
  The queue is capped, duplicate names are refused, and `proposals` returns a bounded
  summary with `total` and `truncated`.
- **Revoking a capability did nothing while it was running.** Deleting its catalog entry
  or clearing `trusted` left the live child serving calls, because the live map held its
  own reference to the old entry. `catalog.reload` now stops anything that was removed,
  untrusted or whose transport changed, and reports what it stopped.
- **The skill size limit was checked after the file was read.** A 768 MB file pushed
  memory past 600 MB and failed with V8's "Invalid string length" rather than the limit
  message. The size is checked before reading.
- **`disable` during a start in flight reported nothing to stop**, then let the child
  start and stay running. It now waits for the pending start and stops it.
- `catalog.reload` swapped entries before parsing the config, so a corrupt `config.json`
  left new entries paired with stale configuration. Both swap together or neither does.

## [0.2.4] - 2026-08-26

### Added

- **An end-to-end proof that the broker is actually dynamic** (`pnpm proof`). The token
  benchmark shows what the model does not have to carry; this shows the other half. A
  capability that nothing loaded at startup is found by intent, inspected for
  permissions, started as a real child process, listed without schemas, narrowed by
  query, asked for one schema deliberately, used for a real `browser_navigate` call
  against the published `@playwright/mcp`, and stopped again — while the host still sees
  exactly one tool.
- Every step is asserted rather than printed: the run fails if more than one tool is
  exposed, if a capability reports itself running before `enable`, if a child schema
  leaks into the default listing, if `includeSchema` is ignored, if the query does not
  narrow the list, or if the capability is still marked running after `disable`. The
  receipt is committed as `bench/dynamic-proof.json`.
- An optional strict Harness smoke (`pnpm smoke:harness:external`) makes the selected
  LM Studio model drive the pinned local Playwright MCP through the single hub tool,
  then proves the child is absent after disable. The standard bundled smoke is unchanged.

### Fixed

- The published package now excludes runtime approvals, pending proposals, smoke
  receipts, compiled tests, and Playwright's generated page snapshots.
- The context benchmark now counts the `enable` response in the discovery total.

## [0.2.3] - 2026-08-26

### Changed

- **A call interrupted by `disable`, or by a child that died, now explains the next
  action.** Both cases surfaced as the raw transport error `MCP error -32000:
  Connection closed`, which tells a small model nothing it can act on. The hub now
  reports which capability stopped and that `enable` is the next call, and it drops a
  dead child from the live map so the retry actually restarts it. Verified that the hub
  stays usable after an interrupted call.

## [0.2.2] - 2026-08-26

Security and lifecycle hardening, each finding reproduced before it was fixed.

### Fixed

- **Concurrent `enable` leaked child processes.** `tools` and `call` both enable a
  capability on demand, so two model calls arriving together on a cold capability
  passed the liveness check at the same time and spawned a child process each. Only
  the last was tracked; the rest were invisible to `status` and survived `close()`.
  Measured with a PID-recording wrapper: three parallel enables spawned three
  processes where one was expected. Concurrent callers now share a single start,
  and `close()` settles in-flight starts before reaping.
- **A transport command could be chosen by model-supplied configuration.**
  `transport.command` was expanded with `${config:...}`, so an operator who
  allowlisted the wrong key would let the model pick which executable runs. Directory
  tokens still expand; `${config:...}` in a command is now rejected outright. Child
  processes were already spawned without a shell, so no argument injection was possible.
- **`approve` accepted any string as a proposal id**, which becomes a filename. It is
  now constrained to the UUID shape `saveProposal` generates.

### Added

- Regression tests for both lifecycle and executable-selection findings, including the
  spawn-counting fixture that makes a leaked process observable.

## [0.2.1] - 2026-08-26

### Added

- A strict seven-action Harness smoke that proves lazy discovery, inspection, tool
  listing and invocation, skill loading, status, and disable through the one outer hub
  tool. The receipt also verifies the exact final assistant token and approved metadata
  visibility for the Web Search Neo and Unity CLI examples.

### Changed

- With no explicit model override, the smoke deterministically selects the smallest
  installed LM Studio LLM marked for tool use. It never downloads a model and unloads
  only a model that the smoke loaded itself.

## [0.2.0] - 2026-08-26

This release measures the project's central claim instead of asserting it, and fixes
the two places where the implementation was working against its own goal.

### Added

- **A reproducible context benchmark** (`pnpm bench`). It starts four real, published
  MCP servers over stdio, reads their actual `tools/list`, and counts the tokens a host
  injects per tool. The hub is measured the same way. Per-tool measurements are
  committed under `bench/snapshots/` so the published table can be re-derived offline.
- **Measured result:** 47 tools across four servers cost 6,200 resident tokens; the hub
  costs 350 — a 94.4% reduction, 17.7x smaller. Including one runtime discovery round
  trip against the heaviest server, a single-capability task costs 1,100 tokens versus
  6,200, or 82.3% less. Break-even is about eight discovery round trips per session.
- **`tools` accepts a query**, filtering a server's tools by name and description. On
  Playwright this is 42 tokens instead of 558 when the agent already knows what it wants.
- **`tools` reports `total`, `matched` and `truncated`** and caps its output, so a server
  with hundreds of tools can no longer dump all of them into the model context.

### Changed

- **`enable` no longer returns the full tool list.** The documented workflow is
  `enable` then `tools`, so returning the list from both made the agent pay for the same
  payload twice — 1,567 tokens where 780 were needed. `enable` now returns the tool
  count and the next action to call.
- **Model-facing JSON is serialized compactly.** Indentation carries no information and
  measured 31% more tokens on the same payload. Programmatic clients are unaffected:
  they still receive the parsed object through `structuredContent`.

## [0.1.0] - 2026-08-25

- First release: a lazy MCP and skill capability broker exposing one `capability_hub`
  tool with `search`, `inspect`, `configure`, `enable`, `disable`, `tools`, `call`,
  `skill.load`, `propose`, `proposals` and `catalog.reload`.
- Human-gated approval queue: model-created proposals cannot execute until approved
  from a separate operator command.
- `stdio` and `streamable-http` child transports, environment-only secrets, and skills
  restricted to reviewed roots.

[0.3.1]: https://github.com/NeoXider/neoxider-mcp-hub/releases/tag/v0.3.1
[0.3.0]: https://github.com/NeoXider/neoxider-mcp-hub/releases/tag/v0.3.0
[0.2.4]: https://github.com/NeoXider/neoxider-mcp-hub/releases/tag/v0.2.4
[0.2.3]: https://github.com/NeoXider/neoxider-mcp-hub/releases/tag/v0.2.3
[0.2.2]: https://github.com/NeoXider/neoxider-mcp-hub/releases/tag/v0.2.2
[0.2.0]: https://github.com/NeoXider/neoxider-mcp-hub/releases/tag/v0.2.0
[0.2.1]: https://github.com/NeoXider/neoxider-mcp-hub/releases/tag/v0.2.1
[0.1.0]: https://github.com/NeoXider/neoxider-mcp-hub/releases/tag/v0.1.0
