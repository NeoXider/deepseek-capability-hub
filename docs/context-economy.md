# One tool instead of every schema you own

## Measuring what lazy MCP loading actually saves

Every MCP server you configure puts its entire tool catalog into the model's context,
in every prompt, on every turn. Four ordinary servers cost 6,200 tokens before the model
has read a single word of your question. This is a measurement of what that costs, what
a lazy broker saves, and — the part usually left out — what the broker costs you back.

All numbers here are produced by a script in the repository, against real published MCP
servers over stdio. Nothing is estimated and nothing is mocked.

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

There is a second cost that is harder to measure and probably larger: choice noise. A
model picking from 47 tools makes worse choices than one picking from 6.

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
| **Capability Hub** | one broker tool | **1** | **350** |

**94.4% smaller. 17.7x.**

Worth noting how uneven the distribution is. `sequential-thinking` exposes *one* tool
and still costs 851 tokens, because its schema is large. Tool count is a bad proxy for
context cost; only the serialized schema tells you the truth.

## The other half: what the broker costs

A broker that hid the tools and then could not use them would be worthless. The saving
is not free — it is **deferred**. What a static configuration pays once up front, the
broker pays at runtime, when the agent actually opens a capability.

Measured against the heaviest server in the catalog, Playwright with its 24 tools:

| Step | Tokens |
|---|---:|
| `search` — find candidates by intent | 72 |
| `inspect` — permissions, transport, config status | 121 |
| `enable` — start the process, report tool count | 22 |
| `tools` — names and descriptions, schemas withheld | 558 |
| **One discovery round trip** | **773** |
| Broker schema, always resident | 350 |
| **Total for a task that opens one capability** | **1,123** |

So a realistic single-capability task costs **1,123 tokens against 6,200 — 82% less.**

### Where it stops winning

Break-even is roughly **eight discovery round trips in one session**. Below that the
broker wins; above it, a static configuration is cheaper, because you end up paying for
the same catalogs repeatedly instead of once.

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

Note the two cheapest lines. `tools` with a query costs **60 tokens instead of 558** when
the agent already knows what it wants. And a schema — the expensive part — arrives only
when explicitly requested, for one tool, at 144 tokens.

## Two things the measurements changed

Building the benchmark was worth it independently of the numbers, because it exposed two
places where the implementation was working against its own purpose.

**The workflow paid for the same list twice.** `enable` returned the full tool list, and
the documented next step is `tools`, which returns it again: 1,567 tokens where 780 were
needed. `enable` now returns a count and a pointer to the next action, at 22 tokens.

**Indentation is not information.** Model-facing JSON was pretty-printed with two-space
indent. On the same payload that measured **31% more tokens** than the compact form, for
zero added meaning. Programmatic clients are unaffected — they read the parsed object
from `structuredContent`.

Neither was visible by reading the code. Both were obvious the moment a number existed.

## Honest limits

- **Four servers, one catalog.** The ratio scales with how much you have configured and
  how little each task uses. Your numbers will differ; the script is in the repo, so run
  it on your own set rather than trusting this one.
- **Tokenizer-specific.** Counted with `o200k_base`. Another tokenizer shifts absolute
  numbers slightly; the ratio is stable.
- **Latency is not measured here.** Starting a child process on demand costs wall-clock
  time that a preloaded server has already spent.
- **Choice quality is not measured here.** The claim that fewer visible tools produce
  better tool selection is plausible and widely repeated, but this benchmark does not
  test it. It measures tokens, and only tokens.

## Reproducing

```bash
git clone https://github.com/NeoXider/deepseek-capability-hub.git
cd deepseek-capability-hub
pnpm install --frozen-lockfile
pnpm bench    # the token table
pnpm proof    # the end-to-end dynamic assertions
```

Per-tool measurements are committed under `bench/snapshots/`, the full report as
`bench/results.json`, and the dynamic receipt as `bench/dynamic-proof.json`, so the
tables above can be re-derived without network access.

MIT © NeoXider
