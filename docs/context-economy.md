# One tool instead of every schema you own

## What lazy MCP loading saves, what it costs back, and what it does to accuracy

Every MCP server you configure puts its entire tool catalog into the model's context,
in every prompt, on every turn. Four ordinary servers cost 6,200 tokens before the model
has read a single word of your question.

This document measures three things, in order of how often they get left out:

1. **What the resident schemas cost**, and what a broker saves.
2. **What the broker costs back**, at runtime, when the agent actually opens something.
3. **What hiding the tools does to the model's ability to pick the right one.**

The third is the one that decides whether any of this is a good idea, and it cannot be
answered by counting tokens. It needs a real model making real choices.

All numbers here are produced by scripts in this repository, against real published MCP
servers over stdio and a real local model. Nothing is estimated and nothing is mocked.

---

## The problem

The Model Context Protocol has a simple contract: a host asks a server for `tools/list`,
and injects the returned tool definitions into the model's context so it knows what it
can call. Each definition carries a name, a description and a JSON Schema for its
arguments.

That works well for one server. It scales badly, because the cost is **resident**: the
schemas sit in the prompt whether or not the task ever touches them. A session that asks
"what changed in this file?" still pays for every browser-automation tool you happen to
have configured.

## Method

For each server: start it over stdio exactly as a host would, call `tools/list`, and
count the tokens of the exact JSON a host injects per tool — `name`, `description` and
`inputSchema`. Tokens are counted with `o200k_base`.

This is deliberately a **conservative floor for the classic side**: real hosts also
inject titles, annotations and per-server framing, which this ignores.

The broker is measured the same way, by starting it and reading its own `tools/list`.
No special case, no self-reporting.

```
pnpm bench
```

## Result: the resident cost

| Server | Purpose | Tools | Context tokens |
|---|---|---:|---:|
| `@modelcontextprotocol/server-everything` | MCP reference server | 13 | 1,075 |
| `@modelcontextprotocol/server-memory` | Knowledge-graph memory | 9 | 891 |
| `@modelcontextprotocol/server-sequential-thinking` | Structured reasoning | 1 | 851 |
| `@playwright/mcp` | Browser automation | 24 | 3,383 |
| **Classic MCP — four servers** | always resident | **47** | **6,200** |
| **Capability Hub** | one broker tool | **1** | **422** |

**93.2% smaller. 14.7x.**

Worth noting how uneven the distribution is. `sequential-thinking` exposes *one* tool
and still costs 851 tokens, because its schema is large. Tool count is a bad proxy for
context cost; only the serialized schema tells you the truth.

### How the saving moves as the catalog grows

The broker's resident cost is **not** a constant. The capability list ships inside the
tool description — see [the accuracy section](#what-hiding-the-tools-does-to-accuracy)
for why that is worth paying for — so it grows with the catalog too, just far more slowly
than 47 JSON schemas do. Past a character budget the list degrades to names only, and the
cost drops back down.

That makes the curve piecewise, and the honest way to report it is to measure it rather
than assume a constant. Each row below starts the real hub against a synthetic catalog of
that size and reads its actual `tools/list`. Only the classic column is projected, from
the measured mean of 1,550 tokens per server:

| Servers configured | Classic tokens | Hub resident | Saved |
|---:|---:|---:|---:|
| 4 | 6,200 | 430 | 93.1% |
| 7 | 10,850 | 507 | 95.3% |
| 10 | 15,500 | 584 | 96.2% |
| 15 | 23,250 | 705 | 97.0% |
| 20 | 31,000 | 826 | 97.3% |
| 30 | 46,500 | 468 | 99.0% |
| 43 | 66,650 | 523 | 99.2% |
| 60 | 93,000 | 595 | **99.4%** |

The drop between 20 and 30 entries is the degradation firing: the full descriptions no
longer fit the budget, the list falls back to names, and the resident cost roughly halves.
Reported real-world setups run heavier than this sample — 67,300 tokens across seven
servers is a figure that circulates widely — which pushes the same curve past 99% sooner,
not later.

## The other half: what the broker costs

A broker that hid the tools and then could not use them would be worthless. The saving
is not free — it is **deferred**. What a static configuration pays once up front, the
broker pays at runtime, when the agent actually opens a capability.

There is no single "per task" number, and publishing one was this document's own earlier
mistake. It charged every task the most expensive possible path and presented the result
as typical. Three scenarios, ordered by how often they actually occur:

| Scenario | Path | Hub tokens | vs 6,200 |
|---|---|---:|---:|
| **idle** — task needs no capability | resident schema only | 422 | **93.2%** saved |
| **direct** — task opens one, knows roughly what it wants | `search` + `tools` with a query | 554 | **91.1%** saved |
| **cautious** — agent also reviews permissions and reads the full list | `search` + `inspect` + `enable` + `tools` | 1,195 | 80.7% saved |

Two things make the direct path cheap, and both were already in the implementation while
the benchmark was ignoring them:

- **`tools` starts the server itself.** `enable` is a separate action for when you want
  to start something deliberately, but it is not on the critical path. Charging every
  task for it was measuring the documentation, not the code.
- **`tools` accepts a query and narrows before returning.** 60 tokens instead of 558 when
  the agent already knows what it is looking for.

The cost of the tool's own *result* is excluded throughout, on both sides. Classic MCP
pays exactly the same tokens for it, so it cancels, and including it inflates the broker's
half of a comparison it does not belong in.

### Where it stops winning

Break-even is roughly **47 direct discoveries** in a single session, or **8** if the agent
takes the cautious path every time. Below that the broker wins; above it, a static
configuration is cheaper, because you end up paying for the same catalogs repeatedly
instead of once.

That gives a clear rule:

- **Use a broker** when you have many servers and each task touches few of them.
- **Do not** when every task uses every tool you have. You will pay twice.

Anyone publishing a "10x context saving" number without this second table is selling
you the first half of an argument.

## Proving it is actually dynamic

The token table shows what the model does *not* carry. It says nothing about whether the
thing still works. So the repository also asserts the full runtime path, against the real
`@playwright/mcp` package:

```
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

Every line is an assertion. The run fails if more than one tool is exposed to the host,
if a capability reports itself running before `enable`, if a child schema leaks into the
default `tools` listing, if `includeSchema` is ignored, if the query fails to narrow the
list, or if the capability is still marked running after `disable`.

## What hiding the tools does to accuracy

Tokens are the easy half. The question that decides whether any of this is a good idea is
whether the model still picks the right tool once the tools are behind a broker — and that
cannot be answered by counting anything. It needs a real model making real choices.

```
pnpm bench:accuracy
```

28 tasks with known-correct answers, run against **Qwen3.8-27B** locally at temperature 0,
thinking disabled. 22 tasks have a correct tool; **6 need no tool at all**, and calling one
anyway is scored as a failure. The hub conditions drive the real hub process over stdio —
the model searches, lists and calls, and the run stops when it commits to a tool.

| Condition | Resident | Overall | Tool tasks | No-tool | False calls | Avg turns | Avg prompt |
|---|---:|---:|---:|---:|---:|---:|---:|
| **classic** — 47 schemas resident | 6,200 | **96.4%** | 100% | 83.3% | **1** | 1 | 7,269 |
| **hub, vague catalog** | 422 | 82.1% | 81.8% | 83.3% | 1 | 3.00 | 2,818 |
| **hub, list not inlined** | 328 | 85.7% | 81.8% | 100% | 0 | 3.54 | 3,047 |
| **hub, as shipped** | 533 | **96.4%** | 95.5% | 100% | **0** | 1.96 | **1,873** |

Four things fall out of this, and two of them were surprises.

**The broker matches the classic setup, on a twelfth of the resident context.** 96.4%
either way, with 533 resident tokens instead of 6,200.

**It also uses fewer tokens in total.** 1,873 average prompt tokens per task against 7,269
— and that is *summed across every turn* of a multi-turn protocol. Three cheap turns beat
one turn that drags 47 schemas along with it. The multi-turn cost that a broker is
supposed to be penalised for did not materialise.

**The classic setup's only failure was a false tool call.** Asked "Is 97 a prime number?",
the model with 47 tools resident reached for `sequentialthinking`. Every hub condition with
a usable catalog scored 100% on the no-tool tasks. This is the "choice noise" claim that
gets repeated everywhere without evidence; here it is, on a small sample, in the direction
everyone assumes.

**Catalog prose is the broker's dominant failure mode.** The vague-catalog run is the same
code, the same servers, the same protocol — only the descriptions differ. `catalog.json`
calls one server "MCP reference server exercising prompts, resources, sampling and every
tool primitive", which never matches a search for adding two numbers.
`catalog-described.json` says it can echo a string, add two numbers and gzip a file. That
edit alone is worth ~14 points. **If you write a catalog, write it so it can be found.**

### Why the capability list is inlined

The middle two rows are the ablation that changed the implementation. With the list
stripped from the tool description the model must spend a `search` to learn what exists —
and on tasks that do not *read* like a search query it never searched at all, answered
directly, and failed. Inlining the list costs about 200 resident tokens and buys back
roughly ten accuracy points and a turn and a half per task.

So `capability_hub` now ships its catalog inside its own description, degrading to names
only, and then to a bare count, as the catalog grows past a character budget. That is the
kink in the scaling table above.

### Limits of this measurement

- **One model, one sample.** 28 tasks on a single 27B local model. It is a real result, not
  a large one.
- **The hub conditions vary between runs.** They are multi-turn against live child
  processes, so borderline tasks flip. Across three runs the classic condition reproduced
  at exactly 96.4% every time, the shipped hub scored 96.4–100%, and the two ablation rows
  landed below both every time — but moved by as much as seven points between runs. Treat
  a one-task difference as noise; treat the direction of the ablations as the finding, not
  their exact size.
- **Selection, not execution.** A hub run stops when the model commits to a tool. That the
  execution path works end to end is asserted separately, above.
- **Ground truth is a judgement.** Two Playwright tasks were removed after the first run
  because `browser_click` and `browser_type` need a `ref` that only `browser_snapshot`
  produces — a model reaching for the snapshot first was right, and the benchmark was
  wrong.



## Prior art, and where this sits

Lazy tool loading is not a new idea and this project did not originate it. By the time
these measurements were taken it had become the default answer to MCP context bloat, with
several independent implementations and one shipped inside the host most people use:

| Approach | Reported saving | Where it lives |
|---|---|---|
| Code execution with MCP (Anthropic, Nov 2025) | 150k → 2k, **98.7%** | a pattern: servers presented as a filesystem of modules |
| Tool Search Tool (Anthropic, Nov 2025) | **85%** | native to the API, and on by default in Claude Code v2.1.7+ |
| [Speakeasy dynamic toolsets v2](https://www.speakeasy.com/blog/how-we-reduced-token-usage-by-100x-dynamic-toolsets-v2/) | **100x** | a product |
| Cursor's file-based tool registry | **46.9%** | native to the editor |
| [dynmcp](https://dynamicmcp.tools/), mcp-cli, assorted gateways | varies | proxies, like this one |

Two consequences worth stating plainly rather than burying:

**If you use Claude Code, you already have this.** MCP Tool Search triggers automatically
once MCP tool descriptions exceed roughly a tenth of the context window. A separate broker
is redundant there, and this project does not pretend otherwise.

**On multi-tool tasks, code execution beats a broker.** A broker re-pays discovery per
capability; code execution composes calls inside an execution environment and never routes
intermediate payloads through the model. The break-even table above is exactly the shape of
that disadvantage.

Where a broker still earns its place:

- **Hosts without it.** DeepSeek Harness, local models, custom agent loops. The
  [opencode feature request](https://github.com/anomalyco/opencode/issues/17482) is open;
  so is [claude-code#11364](https://github.com/anthropics/claude-code/issues/11364). Those
  users get nothing from a feature that shipped in someone else's client.
- **Deferring the process, not just the schema.** Tool Search hides schemas from the model,
  but the servers are connected — something had to enumerate them. This hub keeps
  capabilities *stopped*: `inspect` answers from the catalog while the process does not
  exist, and `tools` starts it. That is RAM, file handles and child processes, not tokens.
  It is a different axis, and this document does not yet measure it.
- **Explicit trust boundaries.** Untrusted proposals require human approval outside the
  MCP; `${config:` interpolation is rejected in commands; loader environment variables
  (`NODE_OPTIONS`, `LD_PRELOAD`, and relatives) are stripped from child processes;
  `streamable-http` is restricted to https or loopback. See [SECURITY.md](../SECURITY.md).

## Honest limits

- **Four servers, one catalog.** The ratio scales with how much you have configured and
  how little each task uses. Your numbers will differ; the scripts are in the repo, so run
  them on your own set rather than trusting this one.
- **Tokenizer-specific.** Counted with `o200k_base`. Another tokenizer shifts absolute
  numbers slightly; the ratio is stable.
- **The scaling table is a projection**, not a measurement. It assumes servers of average
  weight and a broker schema that stays at 350 tokens, which is true by construction but
  worth naming.
- **Latency is not measured here.** Starting a child process on demand costs wall-clock
  time that a preloaded server has already spent.

## Reproducing

```bash
git clone https://github.com/NeoXider/neoxider-mcp-hub.git
cd neoxider-mcp-hub
pnpm install --frozen-lockfile
pnpm bench             # the token tables
pnpm proof             # the end-to-end dynamic assertions
pnpm bench:accuracy    # the tool-selection accuracy run (needs a local model)
```

Per-tool measurements are committed under `bench/snapshots/`, the full token report as
`bench/results.json`, the dynamic receipt as `bench/dynamic-proof.json`, and the accuracy
report as `bench/accuracy.json`, so every table above can be re-derived without network
access.

MIT © NeoXider
