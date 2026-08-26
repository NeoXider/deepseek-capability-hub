#!/usr/bin/env node
// End-to-end proof that the broker is actually dynamic.
//
// The token benchmark shows what the model does NOT have to carry. This shows the other
// half: that a capability nobody loaded at startup can be found, opened, used for a real
// tool call against a real third-party MCP server, and shut down again — with the tool
// schema never entering the model's context unless it is asked for.
//
// Nothing here is mocked. The child is the published @playwright/mcp package.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { encode } from "gpt-tokenizer/encoding/o200k_base";

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(benchDir, "..");
const tokens = (text) => encode(String(text)).length;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    path.join(packageDir, "dist", "src", "server.js"),
    "--catalog", path.join(benchDir, "catalog.json"),
    "--state", path.join(benchDir, "state"),
  ],
  stderr: "ignore",
});
const client = new Client({ name: "capability-hub-dynamic-proof", version: "1.0.0" });
await client.connect(transport);

const steps = [];
async function step(label, input, check) {
  const result = await client.callTool(
    { name: "capability_hub", arguments: input },
    undefined,
    { timeout: 180_000 },
  );
  const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  if (result.isError) throw new Error(`${label} returned an error: ${text.slice(0, 300)}`);
  const problem = check?.(text);
  if (problem) throw new Error(`${label}: ${problem}`);
  steps.push({ step: label, input, tokens: tokens(text), preview: text.slice(0, 160) });
  console.log(`✓ ${label.padEnd(28)} ${String(tokens(text)).padStart(5)} tokens`);
  return text;
}

// 0. The host only ever sees one tool. That is the whole model-facing surface.
const listed = await client.listTools();
const exposed = listed.tools.map((tool) => tool.name);
if (exposed.length !== 1 || exposed[0] !== "capability_hub") {
  throw new Error(`expected exactly one exposed tool, got ${JSON.stringify(exposed)}`);
}
console.log(`✓ host-visible tools          ${exposed.join(", ")}\n`);

// 1. Find a capability by intent, not by name. Nothing is running yet.
const search = await step("search (by intent)", { action: "search", query: "browser automation" }, (text) => {
  const found = JSON.parse(text).capabilities.find((entry) => entry.name === "playwright");
  if (!found) return "playwright was not discoverable by intent";
  if (found.enabled) return "capability must not be running before enable";
  return null;
});

// 2. Read its permissions before granting anything.
await step("inspect (permissions)", { action: "inspect", name: "playwright" }, (text) => {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.permissions) || parsed.permissions.length === 0) return "no permissions declared";
  if (parsed.enabled) return "capability must still be stopped";
  return null;
});

// 3. Start the real child process on demand.
await step("enable (starts process)", { action: "enable", name: "playwright" }, (text) => {
  const parsed = JSON.parse(text);
  if (typeof parsed.tools !== "number" || parsed.tools < 5) return `expected a live tool count, got ${text}`;
  return null;
});

// 4. Names and descriptions only: schemas stay out of context by default.
const toolList = await step("tools (schemas withheld)", { action: "tools", name: "playwright" }, (text) => {
  const parsed = JSON.parse(text);
  if (parsed.schemasIncluded !== false) return "schemas must be opt-in";
  if (parsed.tools.some((tool) => tool.inputSchema !== undefined)) return "a schema leaked into the default listing";
  return null;
});
const available = JSON.parse(toolList).tools.map((tool) => tool.name);

// 5. Narrow to what this task needs.
const wanted = available.find((name) => /navigate/i.test(name)) ?? available[0];
await step("tools (narrowed by query)", { action: "tools", name: "playwright", query: "navigate" }, (text) => {
  const parsed = JSON.parse(text);
  if (parsed.matched >= parsed.total) return "the query did not narrow anything";
  return null;
});

// 6. Ask for one schema, deliberately, only now that it is needed.
await step("tools (one schema, opt-in)", {
  action: "tools", name: "playwright", query: wanted, includeSchema: true,
}, (text) => {
  const parsed = JSON.parse(text);
  if (!parsed.schemasIncluded) return "includeSchema was ignored";
  if (!parsed.tools.some((tool) => tool.inputSchema)) return "no schema returned";
  return null;
});

// 7. A real call, proxied through the single outer tool, against the real child.
const target = "data:text/html,<title>capability-hub-proof</title><h1>ok</h1>";
await step("call (real child tool)", {
  action: "call", name: "playwright", tool: wanted,
  argumentsJson: JSON.stringify({ url: target }),
}, (text) => (text.trim() ? null : "the child returned nothing"));

// 8. Give the resources back.
await step("disable (stops process)", { action: "disable", name: "playwright" }, (text) => {
  const parsed = JSON.parse(text);
  if (parsed.wasEnabled !== true) return "capability was not running";
  return null;
});

await step("search (after disable)", { action: "search", query: "browser automation" }, (text) => {
  const found = JSON.parse(text).capabilities.find((entry) => entry.name === "playwright");
  return found?.enabled ? "capability is still marked running after disable" : null;
});

const discovery = steps
  .filter((entry) => ["search (by intent)", "inspect (permissions)", "enable (starts process)", "tools (schemas withheld)"].includes(entry.step))
  .reduce((sum, entry) => sum + entry.tokens, 0);

console.log(`\nDiscovery for one capability: ${discovery} tokens`);
console.log(`Child tools reachable after enable: ${available.length}`);
console.log(`Tool actually called: ${wanted}`);

writeFileSync(
  path.join(benchDir, "dynamic-proof.json"),
  `${JSON.stringify({ exposedTools: exposed, childToolCount: available.length, calledTool: wanted, discoveryTokens: discovery, steps }, null, 2)}\n`,
  "utf8",
);

await client.close();
console.log("\nAll steps passed: the capability was discovered, opened, used and stopped at runtime.");
process.exit(0);
