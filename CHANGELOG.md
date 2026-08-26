# Changelog

All notable changes to DeepSeek Capability Hub are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.2]: https://github.com/NeoXider/deepseek-capability-hub/releases/tag/v0.2.2
[0.2.0]: https://github.com/NeoXider/deepseek-capability-hub/releases/tag/v0.2.0
[0.2.1]: https://github.com/NeoXider/deepseek-capability-hub/releases/tag/v0.2.1
[0.1.0]: https://github.com/NeoXider/deepseek-capability-hub/releases/tag/v0.1.0
