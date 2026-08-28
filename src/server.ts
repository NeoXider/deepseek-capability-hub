#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CatalogRepository } from "./catalog.js";
import { CapabilityHub } from "./manager.js";
import { capabilityEntrySchema, hubInputShape } from "./schema.js";
import type { CapabilityEntry, HubInput, JsonValue } from "./types.js";

interface HubWireInput {
  action: HubInput["action"];
  query?: string;
  kind?: "mcp" | "skill";
  name?: string;
  tool?: string;
  payloadJson?: string;
  includeSchema?: boolean;
}
// `argumentsJson`, `configJson` and `entryJson` were replaced by `payloadJson` in 0.5.0.
// Reading them here as a compatibility shim was tried and removed: the MCP SDK validates
// the incoming object against the advertised shape and STRIPS unknown keys before the
// handler runs, so the shim could never fire. A caller pinned to the old names does not
// get a deprecation path — it gets an empty payload and a confusing error from the child.
// This is a breaking change, and pretending otherwise in a comment was worse than saying so.

function parseJsonObject(text: string, field: string): Record<string, JsonValue> {
  const value: unknown = JSON.parse(text);
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${field} must contain a JSON object`);
  }
  return value as Record<string, JsonValue>;
}

// `payloadJson` means whatever the action needs, so it is routed by action rather than
// guessed at. Sending it with an action that has no payload is an error rather than a
// silent no-op: a model that puts call arguments on `enable` has made a mistake worth
// hearing about, and the alternative is a capability that starts and does nothing.
const PAYLOAD_TARGET: Partial<Record<HubInput["action"], "arguments" | "config" | "entry">> = {
  call: "arguments",
  configure: "config",
  enable: "config",
  propose: "entry",
};

function decodeWireInput(input: HubWireInput): HubInput {
  const payloadTarget = PAYLOAD_TARGET[input.action];
  if (input.payloadJson !== undefined && payloadTarget === undefined) {
    throw new Error(
      `Action "${input.action}" takes no payloadJson; it is for call, configure, enable and propose`,
    );
  }

  const argumentsJson = payloadTarget === "arguments" ? input.payloadJson : undefined;
  const configJson = payloadTarget === "config" ? input.payloadJson : undefined;
  const entryJson = payloadTarget === "entry" ? input.payloadJson : undefined;

  return {
    action: input.action,
    ...(input.query === undefined ? {} : { query: input.query }),
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.tool === undefined ? {} : { tool: input.tool }),
    ...(argumentsJson === undefined ? {} : { arguments: parseJsonObject(argumentsJson, "payloadJson") }),
    ...(configJson === undefined ? {} : { config: parseJsonObject(configJson, "payloadJson") }),
    ...(input.includeSchema === undefined ? {} : { includeSchema: input.includeSchema }),
    ...(entryJson === undefined
      ? {}
      : { entry: capabilityEntrySchema.parse(JSON.parse(entryJson)) as CapabilityEntry }),
  };
}

function argumentValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

const BASE_DESCRIPTION =
  "Search and inspect a compact catalog, enable a trusted MCP only when needed, list its tools, proxy a tool call, or load one skill body. " +
  'Action "tools" starts a stopped capability by itself, so "enable" is only for starting one deliberately. ' +
  "Avoid includeSchema unless you need the argument shape. Third-party proposals require human approval outside this MCP.";

// Roughly four characters per token; a hard character budget keeps the resident cost
// bounded without dragging a tokenizer into the server's dependencies.
const INLINE_CATALOG_CHAR_BUDGET = 3_000;

// The capability list ships INSIDE the resident description, rather than being something
// the model has to spend a `search` round trip to discover.
//
// This is not a guess. bench/accuracy.mjs measured the same 28 tasks on the same model
// with and without it: 92.9% -> 100% accuracy, and average turns 3.96 -> 2.43, for 223
// extra resident tokens on a four-entry catalog. The failures it removed were the ones
// where the task does not read like a search query, so the model never searched at all
// and simply answered without the capability.
//
// A large catalog would undo the saving this whole project exists for, so the list
// degrades: full descriptions, then names only, then a pointer to `search`.
function describeHub(repository: CatalogRepository): string {
  const entries = repository.all();
  if (entries.length === 0) return BASE_DESCRIPTION;

  const detailed = entries.map((entry) => `${entry.name} (${entry.kind}): ${entry.description}`).join(" | ");
  if (detailed.length <= INLINE_CATALOG_CHAR_BUDGET) {
    return `${BASE_DESCRIPTION}\nAvailable capabilities — ${detailed}`;
  }

  const names = entries.map((entry) => entry.name).join(", ");
  if (names.length <= INLINE_CATALOG_CHAR_BUDGET) {
    return `${BASE_DESCRIPTION}\nAvailable capabilities: ${names}. Use action "search" for descriptions.`;
  }

  return `${BASE_DESCRIPTION}\n${entries.length} capabilities are available; use action "search" to list them.`;
}

async function main(): Promise<void> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageDir = path.resolve(moduleDir, "../..");
  const catalogPath = path.resolve(argumentValue("--catalog") ?? path.join(packageDir, "data", "catalog.json"));
  const stateDir = path.resolve(argumentValue("--state") ?? path.join(packageDir, "data", "state"));

  const repository = new CatalogRepository(catalogPath, stateDir);
  await repository.load();
  const hub = new CapabilityHub(repository);
  const server = new McpServer({ name: "neoxider-mcp-hub", version: "0.1.0" });
  server.server.onclose = () => void hub.close();

  server.registerTool(
    "capability_hub",
    {
      title: "Lazy MCP and skill capability hub",
      description: describeHub(repository),
      inputSchema: hubInputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, extra) => {
      try {
        return await hub.execute(decodeWireInput(input as HubWireInput), extra.signal);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // A child that hangs in initialize would otherwise hold the exit for the SDK's full
  // 60s request timeout, so shutdown races a deadline rather than waiting on it.
  const shutdown = async (): Promise<void> => {
    await Promise.race([
      (async () => {
        await hub.close();
        await server.close();
      })(),
      new Promise((resolve) => setTimeout(resolve, 5000).unref()),
    ]);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
    process.once(signal, () => void shutdown().finally(() => process.exit(0)));
  }
  // StdioServerTransport never listens for end-of-input, so onclose never fires. With no
  // capability running the process happens to exit on its own, but a single live child
  // keeps the event loop alive and the hub lingers forever — one more orphan per host
  // restart. On Windows this is the only path that runs at all: SIGTERM there is
  // TerminateProcess, which no handler observes.
  process.stdin.once("end", () => void shutdown().finally(() => process.exit(0)));
  process.stdin.once("close", () => void shutdown().finally(() => process.exit(0)));

  await server.connect(new StdioServerTransport());
  process.stderr.write(`[capability-hub] ready; catalog=${catalogPath}; entries=${repository.all().length}\n`);
}

main().catch((error) => {
  process.stderr.write(`[capability-hub] fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
