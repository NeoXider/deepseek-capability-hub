<p align="center">
  <img src="docs/cover.png" alt="DeepSeek Capability Hub" width="100%" />
</p>

<h1 align="center">DeepSeek Capability Hub</h1>

<p align="center"><strong>One stable MCP tool instead of every schema you own — 92.5% smaller resident context, at the same tool-selection accuracy. Both measured.</strong></p>

<p align="center">
  <a href="https://github.com/NeoXider/neoxider-mcp-hub/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/NeoXider/neoxider-mcp-hub/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="Node.js 22+" src="https://img.shields.io/badge/Node.js-22%2B-49e7c6" />
  <img alt="MCP" src="https://img.shields.io/badge/MCP-1.30-8b79ff" />
  <img alt="Context saved" src="https://img.shields.io/badge/context-92.5%25%20smaller-49e7c6" />
  <img alt="Accuracy" src="https://img.shields.io/badge/accuracy-96.4%25%20vs%2096.4%25-49e7c6" />
  <a href="CHANGELOG.md"><img alt="Changelog" src="https://img.shields.io/badge/changelog-0.4.0-8b79ff" /></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
</p>

Capability Hub is a lazy MCP and skill broker for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and other MCP clients. The host sees one compact tool, `capability_hub`, instead of paying the context cost of every tool schema from every configured server.

The agent searches a lightweight catalog, inspects permissions, wakes one trusted server, calls it through the hub, and can shut it down again. Skill bodies are loaded only after selection.

## Measured context savings

Numbers below are produced by [`bench/measure.mjs`](bench/measure.mjs), not estimated.
It starts each **real, published** MCP server over stdio, asks for `tools/list`, and
counts the tokens (`o200k_base`) of the exact JSON a host injects per tool
(`name` + `description` + `inputSchema`). The hub is measured the same way, by
starting it and reading its own `tools/list`.

```powershell
pnpm bench
```

| Server | Purpose | Tools | Context tokens |
|---|---|---:|---:|
| `@modelcontextprotocol/server-everything` | MCP reference server | 13 | 1,075 |
| `@modelcontextprotocol/server-memory` | Knowledge-graph memory | 9 | 891 |
| `@modelcontextprotocol/server-sequential-thinking` | Structured reasoning | 1 | 851 |
| `@playwright/mcp` | Browser automation | 24 | 3,383 |
| **Total — classic MCP** | four servers, always resident | **47** | **6,200** |
| **Total — Capability Hub** | one broker tool | **1** | **466** |

**The permanent cost drops 92.5%, or 13.3x.** That is the part of the prompt you pay
for on every single turn, whether or not the task touches a tool.

### The saving grows with your catalog

The hub publishes one schema no matter how many servers you configure, so the classic
side grows linearly while the hub side grows only by a line of catalog prose per entry —
and stops growing once the list degrades to names only. Each hub figure below is measured
by starting the real server against a catalog of that size, not projected:

| Servers configured | Classic tokens | Hub resident | Saved |
|---:|---:|---:|---:|
| 4 | 6,200 | 474 | 92.4% |
| 10 | 15,500 | 628 | 95.9% |
| 20 | 31,000 | 870 | 97.2% |
| 30 | 46,500 | 512 | 98.9% |
| 60 | 93,000 | 639 | **99.3%** |

The drop at 30 is the degradation firing: full descriptions no longer fit the budget, the
list falls back to names, and the resident cost roughly halves.

### The honest other half

The hub is not free: what the classic setup pays once up front, the hub pays at
runtime when the agent actually opens a capability. There is no single "per task"
number — an earlier version of this README published one, and it was the most
expensive possible path presented as typical. Three scenarios:

| Scenario | Path | Hub tokens | vs 6,200 |
|---|---|---:|---:|
| **idle** — task needs no capability | resident schema only | 466 | **92.5%** saved |
| **direct** — task opens one capability | `search` + `tools` with a query | 598 | **90.4%** saved |
| **cautious** — also reviews permissions, reads the full list | `search` + `inspect` + `enable` + `tools` | 1,239 | 80.0% saved |

The direct row still charges a `search`, which the inlined catalog list often makes
unnecessary — a conservative choice, since the bias should run against our own number.

The direct path is cheap for two reasons that were already in the code while the
benchmark was ignoring them: **`tools` starts the server itself**, so `enable` is not
on the critical path, and **`tools` accepts a query**, costing 60 tokens instead of 558
when the agent already knows what it wants:

```json
{"action":"tools","name":"playwright","query":"click"}
```

Break-even is about **47 direct discoveries** in one session, or **8** if the agent takes
the cautious path every time. Below that the hub wins; above it a static configuration is
cheaper. The hub is therefore the right trade when you have many servers and each task
touches few of them, and the wrong one when every task uses every tool you have.

Three design decisions came directly out of these measurements:

- `enable` used to return the full tool list, and the documented next step is `tools` —
  so the workflow paid for the same list twice, 1,567 tokens instead of 780. `enable`
  now returns a count and a pointer to the next action.
- Model-facing JSON is serialized compactly. Indentation is not information, and
  pretty-printing measured 31% more tokens on the same payload.
- The capability list ships inside the tool description rather than behind a `search`
  call — see the accuracy table below for what that bought.

## Measured tool-selection accuracy

Saving context is worthless if the model then picks the wrong tool. So that is measured
too, against **Qwen3.8-27B** running locally at temperature 0 — 28 tasks with known
answers, of which **6 need no tool at all** and calling one is scored as a failure.

```powershell
pnpm bench:accuracy
```

| Condition | Resident | Overall | No-tool tasks | False calls | Avg turns | Avg prompt |
|---|---:|---:|---:|---:|---:|---:|
| **classic** — 47 schemas resident | 6,200 | **96.4%** | 83.3% | **1** | 1 | 7,269 |
| hub, vague catalog | 466 | 85.7% | 83.3% | 1 | 2.93 | 2,922 |
| hub, list not inlined | 372 | 92.9% | 100% | 0 | 3.61 | 3,403 |
| **hub, as shipped** | 577 | **96.4%** | 100% | **0** | 2.18 | **2,262** |

**Same accuracy on a tenth of the resident context — and fewer total tokens.** 2,262
prompt tokens per task against 7,269, summed across every turn of the multi-turn
protocol. The penalty a broker is supposed to pay for extra round trips did not appear.

The classic setup's single failure is worth naming: asked *"Is 97 a prime number?"*, the
model with 47 tools resident reached for `sequentialthinking`. Every hub condition with a
usable catalog scored 100% on the no-tool tasks.

The vague-catalog row is the same code and the same servers — only the descriptions
differ. **Write your catalog so it can be found**; it is worth ~11 points.

The full write-up, including where a broker stops being the right trade, prior art, and
the limits of this sample, is in [docs/context-economy.md](docs/context-economy.md).

Raw per-tool measurements are committed under [`bench/snapshots/`](bench/snapshots)
and the full report in [`bench/results.json`](bench/results.json), so the table can be
re-derived without network access.

## Proof that it is actually dynamic

The table above shows what the model does *not* have to carry. This shows the other
half — that a capability nobody loaded at startup can be found by intent, opened, used
for a real tool call, and shut down again. Nothing in it is mocked: the child is the
published `@playwright/mcp` package.

```powershell
pnpm proof
```

```text
host-visible tools          capability_hub

search (by intent)              72 tokens   playwright found, enabled=false
inspect (permissions)          121 tokens   permissions listed, still stopped
enable (starts process)         22 tokens   real child process, 24 tools live
tools (schemas withheld)       558 tokens   names + descriptions, schemasIncluded=false
tools (narrowed by query)       60 tokens   matched 1 of 24
tools (one schema, opt-in)     144 tokens   schema returned only when asked
call (real child tool)         107 tokens   browser_navigate executed
disable (stops process)         11 tokens   wasEnabled=true
search (after disable)          72 tokens   enabled=false again
```

Each step is asserted, not just printed: the run fails if more than one tool is exposed
to the host, if a capability reports itself running before `enable`, if a child schema
appears in the default `tools` listing, if `includeSchema` is ignored, if the query does
not narrow the list, or if the capability is still marked running after `disable`. The
receipt is written to [`bench/dynamic-proof.json`](bench/dynamic-proof.json).

The contrast with a static configuration is the point: those same 24 Playwright tools
cost 3,383 resident tokens in every prompt of every turn, whether or not the task ever
touches a browser. Here they cost nothing until the model asks, and 24 tools' worth of
names costs 558 tokens once — or 60 if it already knows what it wants.

## Why it exists

Large static MCP configurations waste context and make tool choice noisier. Capability Hub keeps the model-facing surface stable:

```text
search → inspect → enable → tools → call → disable
```

- One fixed schema stays in the Harness prompt.
- Child tool schemas remain outside the model context until requested.
- `tools` returns names and descriptions by default; full schemas are opt-in.
- MCP processes start lazily and live only for the hub process lifetime.
- Skills are discovered by metadata and loaded one at a time.
- Third-party additions enter a human approval queue; the model cannot self-approve executable code.

## Quick start

Requirements: Node.js 22.19+ and pnpm.

```powershell
git clone https://github.com/NeoXider/neoxider-mcp-hub.git
cd neoxider-mcp-hub
pnpm install --frozen-lockfile
pnpm test
pnpm client -- --json '{"action":"search","query":"demo"}'
```

The default catalog contains only a bundled echo MCP and an example ML skill. Tests do not download or execute third-party packages.

## DeepSeek Harness setup

Build the hub, then merge [`examples/dsh/cordis.patch.yml`](examples/dsh/cordis.patch.yml) into the active Harness Web profile and adjust the absolute repository path. Restart Harness.

```powershell
pnpm build
```

Harness will expose one model-facing tool:

```text
mcp__capability_hub__capability_hub
```

Start with:

```json
{"action":"search","query":"web research"}
```

## Model-facing contract

The public schema is intentionally flat so constrained-decoding engines such as LM Studio can compile it reliably. Arbitrary child arguments travel as JSON strings.

Discover and call a tool:

```json
{"action":"tools","name":"web-search-neo"}
```

```json
{
  "action": "call",
  "name": "web-search-neo",
  "tool": "web_info",
  "argumentsJson": "{\"topic\":\"search_status\"}"
}
```

Available actions:

| Action | Purpose |
|---|---|
| `search` | Search compact capability metadata |
| `inspect` | Review one capability, permissions, config and environment status |
| `configure` | Set allowlisted non-secret values through `configJson` |
| `enable` / `disable` | Start or stop one trusted MCP |
| `tools` | List child tools; schemas remain optional |
| `call` | Proxy one child tool call through `argumentsJson` |
| `skill.load` | Load one approved local skill body |
| `propose` | Store an untrusted proposal from `entryJson` |
| `proposals` | List pending proposals |
| `catalog.reload` | Reload approved catalog state |

## Real integration examples

Ready-to-review proposals are included for:

- [Web Search Neo](examples/catalog/web-search-neo.proposal.json) — dynamic web research and browser tooling.
- [Unity CLI MCP](examples/catalog/unity-cli.proposal.json) — the official Unity CLI transport. Its tool list is populated only while a Unity Editor with Unity Pipeline is connected.

These files are examples, not silently trusted defaults. Review paths, versions and permissions before approval.

## Human-gated installation

Model-created proposals are stored under `data/state/pending` and cannot execute. Approve from a separate human-operated command:

```powershell
node dist/src/admin.js approve <proposal-id> --catalog .\data\catalog.json --state .\data\state --yes
```

Then call `catalog.reload` and `enable`. Prefer pinned package versions or immutable Git revisions; avoid floating `latest` installers in approved entries.

## Catalogs, secrets and skills

- MCP transports: `stdio` and `streamable-http`.
- Templates: `${catalogDir}`, `${packageDir}` and explicitly allowlisted `${config:key}` values.
- Secrets: environment-variable references only. Secret-like model configuration keys are rejected.
- Skills: approved local Markdown files, loaded on demand, limited to 256 KiB. Resolved paths must remain under the catalog/package directory; an external directory requires an explicitly reviewed `skill.allowedRoots` entry.
- State: runtime config and proposals are ignored by Git.

## Strict Harness model smoke

The reusable smoke creates an isolated temporary `DSH_HOME`, forces the `read-only` permission preset, and starts a new headless session. Its isolated hub state contains approved **metadata only** for the Web Search Neo and Unity CLI examples; neither capability is started. The smoke validates exactly seven calls through the single outer hub tool — `search`, `inspect`, `tools`, `call` (`add` with `2 + 3`), `skill.load`, `status`, `disable` — followed by the exact assistant token `CAPABILITY_HUB_SMOKE_OK`. Retries, other tools, missing results, tool errors, or extra final text fail validation.

The compact JSON receipt under `data/state/smoke-receipts` records the final assistant text, catalog visibility, selected Harness provider/model, permission preset, action sequence, and model lifecycle. Before loading LM Studio, the smoke checks the process list: an already-loaded matching model is reused and never unloaded by the smoke; a model loaded by the smoke is released after the Harness evidence receipt has been persisted (with TTL as a fallback).

```powershell
pnpm smoke:harness
```

For a stricter source-checkout-only proof, the optional external smoke uses the pinned
local `@playwright/mcp@0.0.79` dev dependency. Qwen must discover it, inspect it,
explicitly enable it, list the narrowed navigation tools, call `browser_navigate` on an
inert `data:` page, load the bundled skill, observe the child running, disable it, and
finally observe an empty enabled list. The receipt rejects retries, any second outer
tool, tool errors, a different model, an unverified page title, or a child that remains
enabled. The browser is headless and isolated, writes only below the temporary smoke
home, and the command never downloads a package:

```powershell
pnpm smoke:harness:external
```

The ordinary `pnpm smoke:harness` remains the fast bundled/offline-contract smoke and
does not require Playwright.

With no model overrides, the default `lmstudio` smoke reads `lms ls --json` and deterministically selects the smallest already-installed `trainedForToolUse` LLM (size first, then `modelKey`). Its `modelKey` is also used as the Harness API model identifier. The smoke never downloads a model. Context is 32K and the idle TTL fallback is one hour. Explicit overrides keep the requested model and disable auto-selection:

```powershell
$env:CAPABILITY_HUB_SMOKE_MODEL = "another-api-identifier"
$env:CAPABILITY_HUB_SMOKE_MODEL_KEY = "installed-lm-studio-model-key"
$env:CAPABILITY_HUB_SMOKE_RECEIPT = "C:\receipts\capability-hub.json"
pnpm smoke:harness
```

Set `CAPABILITY_HUB_SMOKE_DSH_ENTRY` when Harness is installed outside `C:\AI\work\deepseek-harness-runtime`. For non-LM-Studio providers, set `CAPABILITY_HUB_SMOKE_PROVIDER` and, when needed, `CAPABILITY_HUB_SMOKE_PROVIDER_CONFIG_JSON`; the script does not install providers or models.

See [SECURITY.md](SECURITY.md) for the trust boundary.

## Current scope

- Tool calls are proxied; child MCP resources and prompts are not bridged yet.
- Reconnect is explicit: `disable`, then `enable`.
- Remote skill download, signature verification and sandboxed installers are future work.
- A model with unrestricted host shell access can bypass plugin-local policy; use Harness permissions as the outer boundary.

## Companion project

Want a compact animated desktop view of agents, context, models, reasoning and chat? See [NeoXider Agent Deck](https://github.com/NeoXider/neoxider-agent-deck).

## Contributing

Issues and focused pull requests are welcome. New integrations should include a pinned example, a narrow permission description and an end-to-end test.

MIT © NeoXider
