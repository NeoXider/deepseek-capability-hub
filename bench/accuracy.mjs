#!/usr/bin/env node
// Measures TOOL-SELECTION ACCURACY, not tokens.
//
// The token benchmark (measure.mjs) answers "how much context does this cost".
// It says nothing about whether the model still picks the right tool once the
// tools are hidden behind a broker. That is the question that actually decides
// whether lazy loading is a good idea, and it can only be answered by running a
// real model against real tool definitions.
//
// Four conditions, same 28 tasks, same model, temperature 0:
//
//   classic          47 real tool definitions resident, one shot.
//   hubVagueCatalog  the broker against a catalog whose prose does not say what the
//                    servers can do. Isolates catalog quality from the protocol.
//   hubNoList        the broker with the capability list stripped from its description,
//                    reproducing the behaviour from before that list was inlined.
//   hub              the broker exactly as shipped, driven against the REAL hub process.
//
// Six of the tasks need no tool at all. Those are scored too: calling a tool
// when none is needed is a failure, and it is the failure mode that a large
// resident tool list is supposed to cause.
import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { encode } from "gpt-tokenizer/encoding/o200k_base";

// Same accounting as measure.mjs, so the resident cost quoted next to an accuracy
// number is the same number the token benchmark reports.
const tokensOf = (value) => encode(JSON.stringify(value)).length;

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(benchDir, "..");

const BASE_URL = process.env.LMSTUDIO_URL ?? "http://127.0.0.1:1234/v1";
const MODEL = process.env.BENCH_MODEL ?? "qwen3.8-27b-unleashed";
// The broker path needs search -> tools -> call at minimum, and a model that
// re-reads the catalog once still deserves to finish. Six cut runs off mid-protocol.
const MAX_HUB_TURNS = 8;

// Which server owns which tool, for scoring the hub path.
const OWNER = {};
const { servers: FULL } = JSON.parse(readFileSync(path.join(benchDir, "snapshots", "full-tools.json"), "utf8"));
for (const [server, entry] of Object.entries(FULL)) {
  for (const tool of entry.tools) OWNER[tool.name] = server;
}

// Ground truth. `expect: null` means the right answer is to use no tool at all.
const TASKS = [
  { id: "pw-navigate", prompt: "Open https://example.com in the browser.", expect: "browser_navigate" },
  { id: "pw-screenshot", prompt: "Take a screenshot of the page that is currently open.", expect: "browser_take_screenshot" },
  { id: "pw-resize", prompt: "Resize the browser window to 1280 by 720.", expect: "browser_resize" },
  { id: "pw-back", prompt: "Go back to the previous page in the browser history.", expect: "browser_navigate_back" },
  { id: "pw-console", prompt: "Show me the browser console messages for the current page.", expect: "browser_console_messages" },
  // `browser_click` and `browser_type` were dropped from this set. Both require an
  // `element`/`ref` pair that only `browser_snapshot` can produce, so a model that
  // reaches for the snapshot first is behaving correctly, and scoring that as a miss
  // measured the benchmark's ground truth rather than the model. These two need no ref.
  { id: "pw-tabs", prompt: "List all the browser tabs that are currently open.", expect: "browser_tabs" },
  { id: "pw-wait", prompt: "Wait until the text 'Loading complete' appears on the page.", expect: "browser_wait_for" },
  { id: "pw-close", prompt: "Close the browser page.", expect: "browser_close" },

  { id: "mem-create", prompt: "Create a new entity named 'Alice' of type 'person' in my knowledge graph.", expect: "create_entities" },
  { id: "mem-read", prompt: "Read out my entire knowledge graph.", expect: "read_graph" },
  { id: "mem-search", prompt: "Search my knowledge graph for nodes matching 'database migration'.", expect: "search_nodes" },
  { id: "mem-delete", prompt: "Delete the entity called 'ObsoleteProject' from the knowledge graph.", expect: "delete_entities" },
  { id: "mem-observe", prompt: "Add an observation to the existing entity 'Alice': she prefers async communication.", expect: "add_observations" },
  { id: "mem-relate", prompt: "Create a 'works_at' relation from 'Alice' to 'Acme Corp' in the knowledge graph.", expect: "create_relations" },

  { id: "ev-sum", prompt: "Add the numbers 17 and 25 using the available arithmetic tool.", expect: "get-sum" },
  { id: "ev-echo", prompt: "Echo back the exact string 'ping' using the echo tool.", expect: "echo" },
  { id: "ev-env", prompt: "Return the environment variables so I can debug the MCP server configuration.", expect: "get-env" },
  { id: "ev-gzip", prompt: "Compress the file report.txt using gzip.", expect: "gzip-file-as-resource" },
  { id: "ev-image", prompt: "Give me the tiny MCP logo image.", expect: "get-tiny-image" },
  { id: "ev-logging", prompt: "Toggle the simulated random-level logging on.", expect: "toggle-simulated-logging" },

  { id: "st-1", prompt: "Break this architecture problem into numbered thoughts that I can revise and branch as I go.", expect: "sequentialthinking" },
  { id: "st-2", prompt: "I need a structured chain of reasoning steps where earlier steps can be revised later.", expect: "sequentialthinking" },

  { id: "none-capital", prompt: "What is the capital of France?", expect: null },
  { id: "none-tcp", prompt: "Explain the difference between TCP and UDP in two sentences.", expect: null },
  { id: "none-haiku", prompt: "Write a haiku about winter.", expect: null },
  { id: "none-acronym", prompt: "What does the acronym API stand for?", expect: null },
  { id: "none-prime", prompt: "Is 97 a prime number? Answer yes or no.", expect: null },
  { id: "none-translate", prompt: "Translate 'good morning' into Spanish.", expect: null },
];

const SYSTEM =
  "You are a helpful assistant with access to tools. " +
  "If a tool fits the user's request, call it. If no tool is needed, answer directly without calling any tool.";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// LM Studio can evict a model mid-run (idle TTL, or a JIT load for another request).
// The first version of this benchmark treated that as a scored failure and threw away
// two thirds of a 40-minute run, so an eviction is now retried instead of counted.
// `bad allocation` and bare `server_error` were added after a run died two thirds of the
// way through: at a 100k context the 27B model sits at ~22.6 GB of 24 GB, and an
// allocation occasionally loses. These are pressure, not defects, and they retry fine.
const TRANSIENT =
  /model unloaded|failed to load|model_not_found|no model loaded|ECONNREFUSED|fetch failed|bad allocation|server_error|out of memory/i;

async function chat(messages, tools, toolChoice = "auto") {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await chatOnce(messages, tools, toolChoice);
    } catch (error) {
      lastError = error;
      if (!TRANSIENT.test(String(error?.message ?? error))) throw error;
      process.stderr.write(`    (transient: ${String(error.message).slice(0, 80)}; retry ${attempt + 1}/5)\n`);
      // Longer than feels necessary on purpose: an allocation failure needs the previous
      // request's buffers actually released, and a tight retry just fails again.
      await sleep(8000 * (attempt + 1));
    }
  }
  throw lastError;
}

async function chatOnce(messages, tools, toolChoice) {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      ...(tools.length ? { tools, tool_choice: toolChoice } : {}),
      temperature: 0,
      max_tokens: 512,
      // Thinking is disabled here deliberately: it triples latency across hundreds of
      // runs and this benchmark scores the selection, not the prose leading to it.
      reasoning_effort: "none",
    }),
  });
  if (!response.ok) throw new Error(`LM Studio ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const body = await response.json();
  const choice = body.choices?.[0];
  return {
    message: choice?.message ?? {},
    calls: choice?.message?.tool_calls ?? [],
    promptTokens: body.usage?.prompt_tokens ?? 0,
    completionTokens: body.usage?.completion_tokens ?? 0,
  };
}

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- classic

function classicTools() {
  const out = [];
  for (const entry of Object.values(FULL)) {
    for (const tool of entry.tools) {
      out.push({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      });
    }
  }
  return out;
}

async function runClassic(task, tools) {
  const result = await chat([{ role: "system", content: SYSTEM }, { role: "user", content: task.prompt }], tools);
  const picked = result.calls[0]?.function?.name ?? null;
  return {
    picked,
    correct: picked === task.expect,
    turns: 1,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
  };
}

// ---------------------------------------------------------------- hub

async function withHub(catalogFile, stateDir, run) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.join(packageDir, "dist", "src", "server.js"),
      "--catalog", path.join(benchDir, catalogFile),
      "--state", path.join(benchDir, stateDir),
    ],
    env: { ...process.env },
    stderr: "ignore",
  });
  const client = new Client({ name: "capability-hub-accuracy", version: "1.0.0" });
  try {
    await client.connect(transport);
    return await run(client);
  } finally {
    await client.close().catch(() => {});
  }
}

const hubText = async (client, input) => {
  const result = await client.callTool({ name: "capability_hub", arguments: input }, undefined, { timeout: 180_000 });
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
};

// The hub condition scores INTENT, not execution: when the model finally issues
// `call`, the run stops and the requested tool name is compared to ground truth.
// Executing it would launch a real browser 8 times and prove nothing new —
// dynamic-proof.mjs already asserts that the execution path works end to end.
async function runHub(client, task, hubTool) {
  const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: task.prompt }];
  let promptTokens = 0;
  let completionTokens = 0;
  const trace = [];

  for (let turn = 0; turn < MAX_HUB_TURNS; turn += 1) {
    const result = await chat(messages, [hubTool]);
    promptTokens += result.promptTokens;
    completionTokens += result.completionTokens;
    const call = result.calls[0];

    if (!call) {
      // No tool call: correct precisely when the task needed none.
      return { picked: null, correct: task.expect === null, turns: turn + 1, promptTokens, completionTokens, trace };
    }

    const args = parseArgs(call.function?.arguments);
    trace.push({ action: args.action ?? "?", name: args.name, tool: args.tool });

    if (args.action === "call") {
      const picked = args.tool ?? null;
      const server = args.name ?? null;
      const correct = picked === task.expect && (task.expect === null || server === OWNER[task.expect]);
      return { picked, server, correct, turns: turn + 1, promptTokens, completionTokens, trace };
    }

    let observation;
    try {
      observation = await hubText(client, args);
    } catch (error) {
      observation = `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
    messages.push({ role: "assistant", tool_calls: [call], content: null });
    // Generous cap: the model runs with a 100k context, so this exists only to stop a
    // pathological result from running away. A tighter cap truncated real tool listings
    // and charged the hub condition for misses the protocol had not actually caused.
    messages.push({ role: "tool", tool_call_id: call.id, content: observation.slice(0, 20_000) });
  }

  return { picked: null, correct: false, turns: MAX_HUB_TURNS, promptTokens, completionTokens, trace, exhausted: true };
}

// ---------------------------------------------------------------- main

async function main() {
  const tools = classicTools();
  process.stderr.write(`model=${MODEL} tasks=${TASKS.length} classicTools=${tools.length}\n`);

  const report = { model: MODEL, tasks: TASKS.length, toolTasks: TASKS.filter((t) => t.expect).length, conditions: {} };

  // --- classic
  process.stderr.write("\n[classic] 47 resident tool definitions\n");
  const classic = [];
  for (const task of TASKS) {
    const outcome = await runClassic(task, tools);
    classic.push({ id: task.id, expect: task.expect, ...outcome });
    process.stderr.write(`  ${outcome.correct ? "OK  " : "MISS"} ${task.id} -> ${outcome.picked ?? "(no call)"}\n`);
  }
  const classicSummary = summarize(classic);
  classicSummary.residentTokens = tools.reduce(
    (sum, t) => sum + tokensOf({ name: t.function.name, description: t.function.description, inputSchema: t.function.parameters }),
    0,
  );
  report.conditions.classic = classicSummary;

  // --- hub variants
  //
  // Three runs, and the difference between the first two is ONE variable: the prose in
  // the catalog. `catalog.json` describes `everything` as "MCP reference server
  // exercising prompts, resources, sampling and every tool primitive", which never
  // matches a search for adding two numbers. `catalog-described.json` says what the
  // server can do. Same servers, same tools, same protocol.
  //
  // The third adds the capability list to the resident description, so the model can
  // see what exists without spending a `search` round trip first.
  // The server now inlines the capability list into its own tool description by default,
  // so the descriptions below are taken from the real tools/list and only STRIPPED to
  // reproduce the older behaviour. Nothing is hand-written: `hub` is exactly what a host
  // receives today.
  const RUNS = [
    { label: "hubVagueCatalog", catalog: "catalog.json", state: "state", stripList: false },
    { label: "hubNoList", catalog: "catalog-described.json", state: "state-described", stripList: true },
    { label: "hub", catalog: "catalog-described.json", state: "state-described", stripList: false },
  ];

  for (const run of RUNS) {
    await withHub(run.catalog, run.state, async (client) => {
      const listed = await client.listTools(undefined, { timeout: 180_000 });
      const base = listed.tools[0];
      const description = run.stripList
        ? base.description.split("\nAvailable capabilities")[0]
        : base.description;
      const tool = { type: "function", function: { name: base.name, description, parameters: base.inputSchema } };

      process.stderr.write(`\n[${run.label}] 1 resident broker tool, catalog=${run.catalog}, listStripped=${run.stripList}\n`);
      const rows = [];
      for (const task of TASKS) {
        const outcome = await runHub(client, task, tool);
        rows.push({ id: task.id, expect: task.expect, ...outcome });
        process.stderr.write(
          `  ${outcome.correct ? "OK  " : "MISS"} ${task.id} -> ${outcome.picked ?? "(no call)"} (${outcome.turns} turns)\n`,
        );
      }
      const summary = summarize(rows);
      summary.catalog = run.catalog;
      summary.strippedList = run.stripList;
      summary.residentTokens = tokensOf({ name: base.name, description, inputSchema: base.inputSchema });
      report.conditions[run.label] = summary;
    });
  }

  writeFileSync(path.join(benchDir, "accuracy.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  printTable(report);
}

function summarize(rows) {
  const tool = rows.filter((r) => r.expect !== null);
  const none = rows.filter((r) => r.expect === null);
  const pct = (list) => (list.length ? Number(((100 * list.filter((r) => r.correct).length) / list.length).toFixed(1)) : null);

  // The interesting failures cluster by owning server, not across the set, so the
  // per-server split is reported rather than left to be re-derived from the rows.
  const perServer = {};
  for (const row of tool) {
    const server = OWNER[row.expect] ?? "unknown";
    perServer[server] ??= { total: 0, correct: 0 };
    perServer[server].total += 1;
    if (row.correct) perServer[server].correct += 1;
  }
  for (const value of Object.values(perServer)) {
    value.percent = Number(((100 * value.correct) / value.total).toFixed(1));
  }

  return {
    overall: pct(rows),
    toolTasks: pct(tool),
    noToolTasks: pct(none),
    falseToolCalls: none.filter((r) => r.picked !== null).length,
    exhausted: rows.filter((r) => r.exhausted).length,
    perServer,
    avgTurns: Number((rows.reduce((s, r) => s + r.turns, 0) / rows.length).toFixed(2)),
    avgPromptTokens: Math.round(rows.reduce((s, r) => s + r.promptTokens, 0) / rows.length),
    avgCompletionTokens: Math.round(rows.reduce((s, r) => s + r.completionTokens, 0) / rows.length),
    rows,
  };
}

function printTable(report) {
  console.log("");
  console.log(`| Condition | Resident | Overall | Tool tasks | No-tool | False calls | Gave up | Avg turns | Avg prompt |`);
  console.log(`|---|---:|---:|---:|---:|---:|---:|---:|---:|`);
  for (const [name, c] of Object.entries(report.conditions)) {
    console.log(
      `| ${name} | ${(c.residentTokens ?? 0).toLocaleString("en-US")} | **${c.overall}%** | ${c.toolTasks}% | ${c.noToolTasks}% | ` +
        `${c.falseToolCalls} | ${c.exhausted} | ${c.avgTurns} | ${c.avgPromptTokens.toLocaleString("en-US")} |`,
    );
  }
  console.log("");
  const servers = [...new Set(Object.values(report.conditions).flatMap((c) => Object.keys(c.perServer)))];
  console.log(`| Condition | ${servers.join(" | ")} |`);
  console.log(`|---|${servers.map(() => "---:").join("|")}|`);
  for (const [name, c] of Object.entries(report.conditions)) {
    const cells = servers.map((s) => (c.perServer[s] ? `${c.perServer[s].correct}/${c.perServer[s].total}` : "-"));
    console.log(`| ${name} | ${cells.join(" | ")} |`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
