# Changelog

All notable changes to DeepSeek Capability Hub are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-08-28

### Added

- **A head-to-head benchmark against Tool Search** (`pnpm bench:head-to-head`). Every
  previous measurement compared this broker to a static configuration, which cannot
  support a claim of being better than the other lazy approaches — none of them were in
  the room. Now they are: a `tool_search` condition built the way Anthropic's Tool Search
  Tool and Claude Code's MCP Tool Search work, with semantic retrieval over the full
  library, at two catalog sizes (47 and 98 tools) where size is the only variable.

  **The result does not favour this project, and is published as measured.** Accuracy is a
  three-way tie — 96.4% at 47 tools, 92.9% at 98 — and Tool Search is the more compact
  design: 75 resident tokens against this broker's 709, flat as the catalog grows, and
  1,384 average prompt tokens against 2,125. What both lazy approaches beat is the static
  list: a fifth of the prompt tokens, and 100% against 83.3% on the tasks where calling no
  tool is correct.

  Two findings came out of the failures. At scale, "compress report.txt with gzip" pulled
  classic and Tool Search into filesystem distractors while the broker got it right; and
  the broker called `go_back` on the first turn without listing anything, guessing a tool
  name because the inlined capability list told it a browser existed. That is the first
  measured cost of inlining the list.

- `bench/capture-distractors.mjs` and a committed distractor snapshot, so the large scale
  is reproducible offline. Puppeteer is captured but excluded from the distractor set: it
  duplicates Playwright and would be a second correct answer rather than a distraction.

### Fixed

- Retrieval in the Tool Search condition is semantic rather than lexical. The first
  version ranked `add_observations` above `get-sum` for "add two numbers", which would
  have handicapped the competing approach and made any win here an artifact of a
  deliberately weak baseline. Recall@5 of the semantic index is 12/12 on a probe set.
- The benchmark harness retries on HTTP status rather than on message text — a 500 from
  LM Studio arrives as an HTML error page, so matching the body missed it and killed a run
  an hour in — and checkpoints each condition as it completes, so a late failure no longer
  discards every earlier one.

## [0.5.0] - 2026-08-28

Compactness and reliability, both driven by looking at where the cost and the failures
actually were rather than where they were assumed to be.

### Changed

- **BREAKING: `argumentsJson`, `configJson` and `entryJson` are replaced by one
  `payloadJson`.** Decomposing the 466-token resident cost put **288 of it in the input
  schema** — more than the catalog listing and the description combined — and three of
  those fields were mutually exclusive: no action ever read more than one, yet every host
  paid for all three in every prompt. Resident cost is now **422 tokens, 93.2% below a
  four-server classic setup**.

  There is no compatibility shim, and one was attempted and removed: the MCP SDK validates
  the incoming object against the advertised shape and **strips unknown keys before the
  handler runs**, so a shim could never fire. A caller pinned to the old names gets an
  empty payload and a confusing error from the child, not a deprecation warning. The
  bundled CLI still accepts the old spellings, because nothing strips them there.

### Fixed

- **An empty tool list was a dead end.** A capability whose backing application is not
  running starts cleanly and publishes nothing, so `tools` returned `total: 0` with no
  cause and no next step — found against the Unity MCP with the editor closed. The reply
  now names which of the two possible causes happened: a server that published nothing
  (with the likely reason and a retry) or a query that matched nothing (with the count it
  could have seen instead). A populated list still carries no note, so it costs nothing.
- **A child with no `tools/list` handler crashed `enable` with a raw `-32601`.** A server
  exposing only prompts or resources is legitimately like that; it now enables with zero
  tools and explains itself through the same note, instead of surfacing JSON-RPC
  internals to the model.

### Internal

- The accuracy benchmark retries `bad allocation` and `out of memory` alongside the
  eviction errors it already handled. A 27B model at a 100k context sits at ~22.6 GB of
  24 GB, and an allocation occasionally loses; a run died two thirds of the way through
  before this.

## [0.4.0] - 2026-08-28

Two measurements changed the product, and one of them corrected a claim this project had
been publishing about itself.

### Added

- **Tool-selection accuracy is now measured, not assumed** (`pnpm bench:accuracy`). 28
  tasks against a real local model, of which 6 need no tool and calling one is scored as a
  failure. The result: **96.4% for the hub against 96.4% for 47 resident schemas**, on a
  tenth of the resident context and *fewer* total prompt tokens (2,262 vs 7,269 per task,
  summed across every turn of the multi-turn protocol). The classic setup's only failure
  was a false tool call — asked whether 97 is prime, it reached for `sequentialthinking`.
  Every hub condition with a usable catalog scored 100% on the no-tool tasks.
- **The capability list now ships inside the resident tool description**, degrading to
  names only and then to a bare count as the catalog grows past a character budget. This
  is the ablation that justified it: with the list stripped, the model had to spend a
  `search` to learn what existed, and on tasks that did not *read* like a search query it
  never searched at all. Inlining costs ~200 resident tokens and returned 92.9% → 96.4%
  accuracy with average turns 3.61 → 2.18.
- `bench/capture-schemas.mjs` and a committed `bench/snapshots/full-tools.json`, so the
  accuracy run is reproducible offline; `bench/catalog-described.json` as the catalog-prose
  ablation.
- A test asserting the resident description carries the catalog *and* degrades, since that
  description is now load-bearing rather than cosmetic.

### Changed

- **The published "82% per task" figure was wrong.** It charged every task `search` +
  `inspect` + `enable` + the unnarrowed tool list — the most expensive path the protocol
  allows — and presented it as typical. But `tools` starts a stopped capability by itself,
  so `enable` is not on the critical path, and `tools` accepts a query. The benchmark was
  measuring the documentation instead of the code. Reported as three scenarios now:
  **92.5% idle, 90.4% direct, 80.0% cautious**, and break-even moved from ~8 discovery
  round trips per session to **~47** on the direct path.
- The scaling table is measured rather than projected. The hub's resident cost is no longer
  a constant now that the catalog is inlined, and assuming one would have overstated every
  row.
- `docs/context-economy.md` gained a prior-art section. Lazy tool loading is not new, it
  ships natively in Claude Code, and on multi-tool tasks code execution beats a broker.
  Publishing a savings number without saying that reads as not knowing the field.

### Fixed

- Catalog descriptions in the benchmark fixtures now say what each server can *do*. The
  ablation showed this is the broker's dominant failure mode: identical code, identical
  servers, identical protocol, ~11 accuracy points of difference. A capability whose
  description does not name what it does is one the model never finds.

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
