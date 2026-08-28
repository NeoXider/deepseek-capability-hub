#!/usr/bin/env node
// Broker vs Tool Search vs classic MCP, head to head, at two catalog sizes.
//
// accuracy.mjs answers "does hiding the tools behind a broker cost accuracy against a
// static configuration". It never compared this project to the other approaches, which
// made any claim of being better than them unfounded. This script runs the comparison.
//
// Three conditions, identical tasks and identical ground truth:
//
//   classic     every tool definition resident, one shot. The baseline.
//   toolSearch  one resident `tool_search` tool. The model queries the full library by
//               intent, the matching definitions are LOADED so it can call them natively
//               on the next turn. This is the shape Anthropic's Tool Search Tool and
//               Claude Code's MCP Tool Search use.
//   hub         this project, exactly as shipped, driven against the real hub process.
//
// Two scales, and the scale is the only thing that changes between them:
//
//   small   47 tools across the 4 servers that can answer the tasks.
//   large   the same 4 servers plus 5 distractor servers, 98 tools. NO task is
//           answerable by any distractor tool, and the correct answers are unchanged.
//
// That isolation matters. Any accuracy difference between small and large is caused by
// the size of the haystack and nothing else — not different tasks, not different answers.
// The small scale is where a previous run found classic MCP at 96.4%, which left it almost
// no room to degrade; the large scale is the regime where the published gains for lazy
// loading actually come from.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { encode } from "gpt-tokenizer/encoding/o200k_base";

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(benchDir, "..");

const BASE_URL = process.env.LMSTUDIO_URL ?? "http://127.0.0.1:1234/v1";
const MODEL = process.env.BENCH_MODEL ?? "qwen3.8-27b-unleashed";
const MAX_TURNS = 8;
// Anthropic describes Tool Search loading roughly three to five tools per query.
const TOOL_SEARCH_TOP_K = 5;

const tokensOf = (value) => encode(typeof value === "string" ? value : JSON.stringify(value)).length;

const answering = JSON.parse(readFileSync(path.join(benchDir, "snapshots", "full-tools.json"), "utf8")).servers;
// Puppeteer is captured but deliberately NOT used as a distractor. It is a functional
// duplicate of Playwright, so a model answering "open example.com" with
// `puppeteer_navigate` would be behaving correctly while this benchmark scored it wrong.
// That would measure the ground truth, not the approach. A distractor has to be
// plausible-but-irrelevant, never a second right answer.
const DISTRACTOR_EXCLUDE = new Set(["puppeteer"]);

const distractorFile = path.join(benchDir, "snapshots", "distractor-tools.json");
const distractors = existsSync(distractorFile)
  ? Object.fromEntries(
      Object.entries(JSON.parse(readFileSync(distractorFile, "utf8")).servers).filter(
        ([name]) => !DISTRACTOR_EXCLUDE.has(name),
      ),
    )
  : {};

const OWNER = {};
for (const [server, entry] of Object.entries(answering)) {
  for (const tool of entry.tools) OWNER[tool.name] = server;
}

// Ground truth, identical to accuracy.mjs. `expect: null` means using no tool is correct.
const TASKS = [
  { id: "pw-navigate", prompt: "Open https://example.com in the browser.", expect: "browser_navigate" },
  { id: "pw-screenshot", prompt: "Take a screenshot of the page that is currently open.", expect: "browser_take_screenshot" },
  { id: "pw-resize", prompt: "Resize the browser window to 1280 by 720.", expect: "browser_resize" },
  { id: "pw-back", prompt: "Go back to the previous page in the browser history.", expect: "browser_navigate_back" },
  { id: "pw-console", prompt: "Show me the browser console messages for the current page.", expect: "browser_console_messages" },
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
const TRANSIENT =
  /model unloaded|failed to load|model_not_found|no model loaded|ECONNREFUSED|fetch failed|bad allocation|server_error|out of memory/i;

async function chat(messages, tools) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await chatOnce(messages, tools);
    } catch (error) {
      lastError = error;
      if (!error?.transient && !TRANSIENT.test(String(error?.message ?? error))) throw error;
      process.stderr.write(`    (transient: ${String(error.message).slice(0, 70)}; retry ${attempt + 1}/5)\n`);
      await sleep(8000 * (attempt + 1));
    }
  }
  throw lastError;
}

async function chatOnce(messages, tools) {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      ...(tools.length ? { tools, tool_choice: "auto" } : {}),
      temperature: 0,
      max_tokens: 512,
      reasoning_effort: "none",
    }),
  });
  if (!response.ok) {
    // Tagged by STATUS, not by message. A 500 from LM Studio arrives as an HTML error
    // page, so matching the body text missed it and killed a run an hour in.
    const error = new Error(`LM Studio ${response.status}: ${(await response.text()).slice(0, 200)}`);
    if (response.status >= 500 || response.status === 429) error.transient = true;
    throw error;
  }
  const body = await response.json();
  const choice = body.choices?.[0];
  return {
    calls: choice?.message?.tool_calls ?? [],
    message: choice?.message ?? {},
    promptTokens: body.usage?.prompt_tokens ?? 0,
    completionTokens: body.usage?.completion_tokens ?? 0,
  };
}

const parseArgs = (raw) => {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

// ---------------------------------------------------------------- libraries

function libraryFor(scale) {
  const sources = scale === "large" ? [answering, distractors] : [answering];
  const tools = [];
  for (const source of sources) {
    for (const entry of Object.values(source)) {
      for (const tool of entry.tools) tools.push(tool);
    }
  }
  return tools;
}

const asFunction = (tool) => ({
  type: "function",
  function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
});

// ---------------------------------------------------------------- classic

async function runClassic(task, library) {
  const tools = library.map(asFunction);
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

// ---------------------------------------------------------------- tool search

const TOOL_SEARCH_DEF = {
  type: "function",
  function: {
    name: "tool_search",
    description:
      "Search the full tool library by intent and load the tools that match, so they can be called directly afterwards. Call this first whenever a task needs a tool.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "What you are trying to do, in a few words." } },
      required: ["query"],
    },
  },
};

// Retrieval for the Tool Search condition is SEMANTIC, using a real embedding model.
//
// The first version scored term overlap, and it failed "add two numbers" -> get-sum
// because `add_observations` won on the literal word "add". Shipping that would have
// handicapped the competing approach and turned any win here into an artifact of a
// deliberately weak baseline. Anthropic describes Tool Search as searching by intent, so
// intent is what this does.
const EMBED_MODEL = process.env.BENCH_EMBED_MODEL ?? "text-embedding-nomic-embed-text-v1.5";

// Retried on the same transient classes as the chat path. An embedding model that LM
// Studio has placed behind its LM Link relay drops the connection occasionally, and an
// unretried failure here kills a two-hour run before the first condition finishes.
async function embed(inputs) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: EMBED_MODEL, input: inputs }),
      });
      if (!response.ok) throw new Error(`embeddings ${response.status}: ${(await response.text()).slice(0, 200)}`);
      const body = await response.json();
      return body.data.map((row) => row.embedding);
    } catch (error) {
      lastError = error;
      const message = String(error?.message ?? error);
      if (!TRANSIENT.test(message) && !/LM Link|connection closed/i.test(message)) throw error;
      process.stderr.write(`    (embed transient: ${message.slice(0, 70)}; retry ${attempt + 1}/5)\n`);
      await sleep(8000 * (attempt + 1));
    }
  }
  throw lastError;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// Embedded once per scale and reused, so the cost of retrieval never lands on the model.
async function buildIndex(library) {
  const vectors = [];
  const batch = 32;
  for (let start = 0; start < library.length; start += batch) {
    const slice = library.slice(start, start + batch);
    vectors.push(...(await embed(slice.map((tool) => `${tool.name}: ${tool.description ?? ""}`))));
  }
  return vectors;
}

const queryCache = new Map();

async function searchLibrary(library, index, query) {
  const text = String(query ?? "").trim();
  if (!text) return library.slice(0, TOOL_SEARCH_TOP_K);
  let vector = queryCache.get(text);
  if (!vector) {
    [vector] = await embed([text]);
    queryCache.set(text, vector);
  }
  return library
    .map((tool, position) => ({ tool, score: cosine(vector, index[position]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOOL_SEARCH_TOP_K)
    .map((row) => row.tool);
}

async function runToolSearch(task, library, index) {
  const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: task.prompt }];
  // Definitions found by a search are LOADED, exactly as a host implementing Tool Search
  // would: the model calls them natively on the following turn rather than proxying.
  let tools = [TOOL_SEARCH_DEF];
  let promptTokens = 0;
  let completionTokens = 0;
  const trace = [];

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const result = await chat(messages, tools);
    promptTokens += result.promptTokens;
    completionTokens += result.completionTokens;
    const call = result.calls[0];

    if (!call) {
      return { picked: null, correct: task.expect === null, turns: turn + 1, promptTokens, completionTokens, trace };
    }
    if (call.function?.name !== "tool_search") {
      const picked = call.function?.name ?? null;
      return { picked, correct: picked === task.expect, turns: turn + 1, promptTokens, completionTokens, trace };
    }

    const query = parseArgs(call.function?.arguments).query ?? "";
    const found = await searchLibrary(library, index, query);
    trace.push({ query, found: found.map((tool) => tool.name) });
    const known = new Set(tools.map((tool) => tool.function.name));
    for (const tool of found) {
      if (!known.has(tool.name)) tools = [...tools, asFunction(tool)];
    }
    messages.push({ role: "assistant", tool_calls: [call], content: null });
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: JSON.stringify({
        loaded: found.map((tool) => ({ name: tool.name, description: tool.description })),
        note: found.length
          ? "These tools are now available to call directly."
          : "Nothing matched. Try different words, or answer without a tool.",
      }),
    });
  }
  return { picked: null, correct: false, turns: MAX_TURNS, promptTokens, completionTokens, trace, exhausted: true };
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
  const client = new Client({ name: "capability-hub-head-to-head", version: "1.0.0" });
  try {
    await client.connect(transport);
    return await run(client);
  } finally {
    await client.close().catch(() => {});
  }
}

async function runHub(client, task, hubTool) {
  const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: task.prompt }];
  let promptTokens = 0;
  let completionTokens = 0;
  const trace = [];

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const result = await chat(messages, [hubTool]);
    promptTokens += result.promptTokens;
    completionTokens += result.completionTokens;
    const call = result.calls[0];

    if (!call) {
      return { picked: null, correct: task.expect === null, turns: turn + 1, promptTokens, completionTokens, trace };
    }
    const args = parseArgs(call.function?.arguments);
    trace.push({ action: args.action ?? "?", name: args.name, tool: args.tool });

    if (args.action === "call") {
      const picked = args.tool ?? null;
      const correct = picked === task.expect && (task.expect === null || args.name === OWNER[task.expect]);
      return { picked, server: args.name, correct, turns: turn + 1, promptTokens, completionTokens, trace };
    }

    let observation;
    try {
      const raw = await client.callTool({ name: "capability_hub", arguments: args }, undefined, { timeout: 180_000 });
      observation = raw.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    } catch (error) {
      observation = `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
    messages.push({ role: "assistant", tool_calls: [call], content: null });
    messages.push({ role: "tool", tool_call_id: call.id, content: observation.slice(0, 20_000) });
  }
  return { picked: null, correct: false, turns: MAX_TURNS, promptTokens, completionTokens, trace, exhausted: true };
}

// ---------------------------------------------------------------- reporting

function summarize(rows, residentTokens) {
  const tool = rows.filter((row) => row.expect !== null);
  const none = rows.filter((row) => row.expect === null);
  const pct = (list) =>
    list.length ? Number(((100 * list.filter((row) => row.correct).length) / list.length).toFixed(1)) : null;
  return {
    residentTokens,
    overall: pct(rows),
    toolTasks: pct(tool),
    noToolTasks: pct(none),
    falseToolCalls: none.filter((row) => row.picked !== null).length,
    exhausted: rows.filter((row) => row.exhausted).length,
    avgTurns: Number((rows.reduce((sum, row) => sum + row.turns, 0) / rows.length).toFixed(2)),
    avgPromptTokens: Math.round(rows.reduce((sum, row) => sum + row.promptTokens, 0) / rows.length),
    rows,
  };
}

// A full run is six conditions over roughly two hours against a local model that
// occasionally 500s or evicts itself. Three runs were lost to a late failure discarding
// every earlier condition, so each condition is checkpointed the moment it finishes and
// a restart resumes from there. Delete bench/head-to-head.json to force a clean run.
const REPORT_PATH = path.join(benchDir, "head-to-head.json");

function loadCheckpoint(model) {
  if (!existsSync(REPORT_PATH)) return null;
  try {
    const saved = JSON.parse(readFileSync(REPORT_PATH, "utf8"));
    // Results from a different model or task set are not resumable.
    if (saved.model !== model || saved.tasks !== TASKS.length) return null;
    return saved;
  } catch {
    return null;
  }
}

async function main() {
  const scales = [
    { name: "small", catalog: "catalog-described.json", state: "state-described" },
    { name: "large", catalog: "catalog-large.json", state: "state-large" },
  ];
  const report = loadCheckpoint(MODEL) ?? {
    model: MODEL,
    tasks: TASKS.length,
    toolSearchTopK: TOOL_SEARCH_TOP_K,
    scales: {},
  };
  const save = () => writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const done = (scaleName, condition) => report.scales[scaleName]?.conditions?.[condition] !== undefined;

  for (const scale of scales) {
    const library = libraryFor(scale.name);
    const classicResident = library.reduce(
      (sum, tool) => sum + tokensOf({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }),
      0,
    );
    process.stderr.write(`\n=== scale ${scale.name}: ${String(library.length)} tools, classic resident ${String(classicResident)} ===\n`);
    report.scales[scale.name] ??= { tools: library.length, conditions: {} };
    const conditions = report.scales[scale.name].conditions;

    if (done(scale.name, "classic")) {
      process.stderr.write(`\n[${scale.name}/classic] resumed from checkpoint\n`);
    } else {
      process.stderr.write(`\n[${scale.name}/classic]\n`);
      const classicRows = [];
      for (const task of TASKS) {
        const outcome = await runClassic(task, library);
        classicRows.push({ id: task.id, expect: task.expect, ...outcome });
        process.stderr.write(`  ${outcome.correct ? "OK  " : "MISS"} ${task.id} -> ${outcome.picked ?? "(no call)"}\n`);
      }
      conditions.classic = summarize(classicRows, classicResident);
      save();
    }

    if (done(scale.name, "toolSearch")) {
      process.stderr.write(`\n[${scale.name}/toolSearch] resumed from checkpoint\n`);
    } else {
      process.stderr.write(`\n[${scale.name}/toolSearch] embedding ${String(library.length)} tools with ${EMBED_MODEL}\n`);
      const searchIndex = await buildIndex(library);
      const searchRows = [];
      for (const task of TASKS) {
        const outcome = await runToolSearch(task, library, searchIndex);
        searchRows.push({ id: task.id, expect: task.expect, ...outcome });
        process.stderr.write(
          `  ${outcome.correct ? "OK  " : "MISS"} ${task.id} -> ${outcome.picked ?? "(no call)"} (${String(outcome.turns)} turns)\n`,
        );
      }
      conditions.toolSearch = summarize(searchRows, tokensOf(TOOL_SEARCH_DEF.function));
      save();
    }

    if (done(scale.name, "hub")) {
      process.stderr.write(`\n[${scale.name}/hub] resumed from checkpoint\n`);
      continue;
    }
    await withHub(scale.catalog, scale.state, async (client) => {
      const base = (await client.listTools(undefined, { timeout: 180_000 })).tools[0];
      const hubTool = {
        type: "function",
        function: { name: base.name, description: base.description, parameters: base.inputSchema },
      };
      process.stderr.write(`\n[${scale.name}/hub] catalog=${scale.catalog}\n`);
      const hubRows = [];
      for (const task of TASKS) {
        const outcome = await runHub(client, task, hubTool);
        hubRows.push({ id: task.id, expect: task.expect, ...outcome });
        process.stderr.write(
          `  ${outcome.correct ? "OK  " : "MISS"} ${task.id} -> ${outcome.picked ?? "(no call)"} (${String(outcome.turns)} turns)\n`,
        );
      }
      conditions.hub = summarize(
        hubRows,
        tokensOf({ name: base.name, description: base.description, inputSchema: base.inputSchema }),
      );
      save();
    });
  }

  save();
  printTables(report);
}

function printTables(report) {
  for (const [scaleName, scale] of Object.entries(report.scales)) {
    console.log("");
    console.log(`### ${scaleName} — ${String(scale.tools)} tools`);
    console.log("");
    console.log(`| Condition | Resident | Overall | Tool tasks | No-tool | False calls | Gave up | Avg turns | Avg prompt |`);
    console.log(`|---|---:|---:|---:|---:|---:|---:|---:|---:|`);
    for (const [name, c] of Object.entries(scale.conditions)) {
      console.log(
        `| ${name} | ${c.residentTokens.toLocaleString("en-US")} | **${String(c.overall)}%** | ${String(c.toolTasks)}% | ` +
          `${String(c.noToolTasks)}% | ${String(c.falseToolCalls)} | ${String(c.exhausted)} | ${String(c.avgTurns)} | ` +
          `${c.avgPromptTokens.toLocaleString("en-US")} |`,
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
