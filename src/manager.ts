import { readFile, stat } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CatalogRepository } from "./catalog.js";
import type {
  CapabilityEntry,
  HubInput,
  JsonValue,
  McpCapabilityEntry,
  SkillCapabilityEntry,
} from "./types.js";

interface LiveMcp {
  readonly entry: McpCapabilityEntry;
  readonly client: Client;
  tools: Tool[];
}

const SECRET_KEY_PATTERN = /(secret|token|password|passwd|api[-_.]?key|credential|private[-_.]?key)/i;
const MAX_SKILL_BYTES = 256 * 1024;
const MAX_SEARCH_RESULTS = 50;
const MAX_TOOL_RESULTS = 60;
const MAX_PROPOSAL_RESULTS = 25;
const MAX_FIELD_CHARS = 400;
// Setting any of these makes the child interpreter load code before the server's own
// entry point runs, so a value reaching one of them is arbitrary code execution — no
// matter how innocuous the catalog key that produced it looks.
// Only these mean the pipe to the child is gone. Anything else — a tool that returned an
// error, a schema mismatch, a local stringify blowing the stack — leaves the child alive.
const TRANSPORT_FAILURE = /connection closed|EPIPE|ECONNRESET|ECONNREFUSED|terminated|socket hang up|write after end/i;
const LOADER_ENV = /^(NODE_OPTIONS|NODE_REPL_EXTERNAL_MODULE|LD_PRELOAD|LD_AUDIT|LD_LIBRARY_PATH|DYLD_[A-Z_]+|PYTHONSTARTUP|PYTHONPATH|PERL5OPT|PERL5LIB|RUBYOPT|BASH_ENV|ENV|GIT_SSH|GIT_SSH_COMMAND|GIT_EXTERNAL_DIFF)$/i;

function asStructured(value: JsonValue): Record<string, unknown> {
  return Array.isArray(value) || value === null || typeof value !== "object" ? { value } : value;
}

// Every byte here lands in the model's context, and indentation is not information:
// pretty-printing this payload measured 31% more tokens than the compact form.
// Programmatic clients still get the parsed object through structuredContent.
function jsonResult(value: JsonValue): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: asStructured(value),
  };
}

function textResult(text: string, metadata?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text }],
    ...(metadata === undefined ? {} : { structuredContent: metadata }),
  };
}

function requireName(input: HubInput): string {
  if (!input.name) throw new Error(`Action "${input.action}" requires name`);
  return input.name;
}

function publicEntry(entry: CapabilityEntry, enabled: boolean): Record<string, JsonValue> {
  return {
    kind: entry.kind,
    name: entry.name,
    description: entry.description,
    tags: entry.tags ?? [],
    trusted: entry.trusted,
    enabled,
  };
}

function environmentStatus(names: readonly string[]): Record<string, JsonValue> {
  return Object.fromEntries(names.map((name) => [name, typeof process.env[name] === "string"]));
}

function scalarConfig(config: Record<string, JsonValue>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new Error(`Configuration key "${key}" must be a string, number, or boolean`);
      }
      return [key, String(value)];
    }),
  );
}

export class CapabilityHub {
  readonly repository: CatalogRepository;
  readonly #live = new Map<string, LiveMcp>();
  readonly #starting = new Map<string, Promise<JsonValue>>();

  constructor(repository: CatalogRepository) {
    this.repository = repository;
  }

  async execute(input: HubInput, signal: AbortSignal): Promise<CallToolResult> {
    switch (input.action) {
      case "search":
        return this.search(input);
      case "inspect":
        return this.inspect(requireName(input));
      case "status":
        return this.status();
      case "configure":
        return await this.configure(requireName(input), input.config ?? {});
      case "enable":
        if (input.config) await this.configure(requireName(input), input.config);
        return jsonResult(await this.enable(requireName(input)));
      case "disable":
        return jsonResult(await this.disable(requireName(input)));
      case "tools":
        return await this.tools(requireName(input), input.includeSchema ?? false, input.query);
      case "call":
        return await this.call(requireName(input), input.tool, input.arguments ?? {}, signal);
      case "skill.load":
        return await this.loadSkill(requireName(input));
      case "propose":
        return await this.propose(input.entry);
      case "proposals":
        return await this.listProposals();
      case "catalog.reload":
        return await this.reloadCatalog();
    }
  }

  search(input: Pick<HubInput, "query" | "kind">): CallToolResult {
    const matches = this.repository.search(input.query, input.kind);
    const limited = matches.slice(0, MAX_SEARCH_RESULTS);
    return jsonResult({
      capabilities: limited.map((entry) => publicEntry(entry, this.#live.has(entry.name))),
      total: matches.length,
      truncated: limited.length !== matches.length,
    });
  }

  inspect(name: string): CallToolResult {
    const entry = this.requireEntry(name);
    const base = {
      ...publicEntry(entry, this.#live.has(name)),
      source: entry.source ?? "local catalog",
      permissions: entry.permissions ?? [],
    };
    if (entry.kind === "skill") {
      return jsonResult({ ...base, loadWith: { action: "skill.load", name } });
    }
    const configured = this.repository.configFor(name);
    const transport = entry.transport;
    return jsonResult({
      ...base,
      transport: transport.type,
      configurable: entry.configurable ?? [],
      configuredKeys: Object.keys(configured),
      requiredEnvironment:
        transport.type === "stdio"
          ? environmentStatus(transport.requiredEnv ?? [])
          : environmentStatus(Object.values(transport.headersFromEnv ?? {}).map((header) => header.env)),
      enableWith: { action: "enable", name },
    });
  }

  status(): CallToolResult {
    return jsonResult({
      enabled: [...this.#live.values()].map((live) => ({
        name: live.entry.name,
        tools: live.tools.length,
      })),
      catalogEntries: this.repository.all().length,
      tokenMode: "single-proxy-tool",
    });
  }

  async configure(name: string, config: Record<string, JsonValue>): Promise<CallToolResult> {
    const entry = this.requireMcp(name);
    if (this.#live.has(name)) throw new Error(`Disable "${name}" before changing its configuration`);
    const allowed = new Set(entry.configurable ?? []);
    for (const key of Object.keys(config)) {
      if (!allowed.has(key)) throw new Error(`Configuration key "${key}" is not allowed for "${name}"`);
      if (SECRET_KEY_PATTERN.test(key)) {
        throw new Error(`Secret-like configuration key "${key}" is forbidden; use environment references`);
      }
    }
    scalarConfig(config);
    await this.repository.setConfig(name, config);
    return jsonResult({ configured: name, keys: Object.keys(config) });
  }

  // `tools` and `call` both enable on demand, so two model calls arriving together on
  // a cold capability used to pass the liveness check at the same time, spawn a child
  // process each, and leave every process but the last untracked — invisible to
  // `status` and not reaped by `close()`. Concurrent callers now share one attempt.
  async enable(name: string): Promise<JsonValue> {
    const existing = this.#live.get(name);
    if (existing) return { enabled: name, alreadyEnabled: true, tools: existing.tools.length };
    const pending = this.#starting.get(name);
    if (pending) return await pending;
    const attempt = this.startMcp(name).finally(() => this.#starting.delete(name));
    this.#starting.set(name, attempt);
    return await attempt;
  }

  private async startMcp(name: string): Promise<JsonValue> {
    const entry = this.requireMcp(name);
    if (!entry.trusted) {
      throw new Error(`Capability "${name}" is untrusted. Submit a proposal and approve it outside the MCP first`);
    }
    const config = this.repository.configFor(name);
    scalarConfig(config);
    const client = new Client({ name: "capability-hub", version: "0.1.0" });
    const live: LiveMcp = { entry, client, tools: [] };
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      live.tools = await this.collectTools(client);
      process.stderr.write(`[capability-hub] ${name}: tool catalog refreshed (${live.tools.length})\n`);
    });

    const transport = this.createTransport(entry, config) as unknown as Transport;
    try {
      await client.connect(transport);
      live.tools = await this.collectTools(client);
      this.#live.set(name, live);
      // Returning the whole tool list here made the documented workflow pay for the
      // same list twice, since the next step is "tools". Report the count instead.
      return {
        enabled: name,
        tools: live.tools.length,
        nextStep: { action: "tools", name },
      };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async disable(name: string): Promise<JsonValue> {
    // A start still in flight has not reached the live map yet, so reporting
    // wasEnabled:false here told the model nothing needed stopping while the child went
    // on to start and stay running.
    const starting = this.#starting.get(name);
    if (starting) await starting.catch(() => undefined);
    const live = this.#live.get(name);
    if (!live) return { disabled: name, wasEnabled: false };
    this.#live.delete(name);
    await live.client.close();
    return { disabled: name, wasEnabled: true };
  }

  async tools(name: string, includeSchema: boolean, query?: string): Promise<CallToolResult> {
    if (!this.#live.has(name)) await this.enable(name);
    const live = this.#live.get(name);
    if (!live) throw new Error(`Failed to enable "${name}"`);
    // A server with a hundred tools would otherwise dump all of them into context.
    // The query narrows the list first, and the cap bounds the worst case.
    const needle = query?.trim().toLowerCase();
    const matched = needle
      ? live.tools.filter((tool) =>
          `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(needle),
        )
      : live.tools;
    const limited = matched.slice(0, MAX_TOOL_RESULTS);
    return jsonResult({
      server: name,
      tools: limited.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        ...(includeSchema ? { inputSchema: tool.inputSchema as JsonValue } : {}),
      })),
      total: live.tools.length,
      matched: matched.length,
      truncated: limited.length !== matched.length,
      schemasIncluded: includeSchema,
    });
  }

  async call(
    name: string,
    toolName: string | undefined,
    args: Record<string, JsonValue>,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    if (!toolName) throw new Error('Action "call" requires tool');
    if (!this.#live.has(name)) await this.enable(name);
    const live = this.#live.get(name);
    if (!live) throw new Error(`Failed to enable "${name}"`);
    if (!live.tools.some((tool) => tool.name === toolName)) {
      throw new Error(`MCP "${name}" has no tool "${toolName}"; call action "tools" to refresh names`);
    }
    let result;
    try {
      result = await live.client.callTool({ name: toolName, arguments: args }, undefined, { signal });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // Not every failure means the child died, and tearing a healthy server down on a
      // cancelled call or a local serialisation error is a self-inflicted restart loop.
      if (!this.#live.has(name)) {
        throw new Error(`MCP "${name}" was disabled while "${toolName}" was running; call action "enable" and retry`);
      }
      if (signal.aborted) {
        throw new Error(`Call "${toolName}" on "${name}" was cancelled (${detail}); the server is still enabled`);
      }
      if (!TRANSPORT_FAILURE.test(detail)) {
        // The child answered, or the request never left this process. Either way it is
        // still usable, and the model should see the real reason rather than a restart.
        throw new Error(`MCP "${name}" rejected "${toolName}": ${detail}`);
      }
      this.#live.delete(name);
      await live.client.close().catch(() => undefined);
      throw new Error(`MCP "${name}" stopped responding during "${toolName}" (${detail}); call action "enable" to restart it`);
    }
    if (!("content" in result) || !Array.isArray(result.content)) {
      return textResult(JSON.stringify("toolResult" in result ? result.toolResult : result));
    }
    return result as CallToolResult;
  }

  async loadSkill(name: string): Promise<CallToolResult> {
    const entry = this.requireSkill(name);
    const skillPath = await this.repository.resolveTrustedSkillPath(entry);
    // Checking after the read defeated the point: a 768 MB file pushed RSS past 600 MB and
    // failed with V8's "Invalid string length" instead of the limit message. stat runs on
    // the already-realpath'd path, so this does not widen the TOCTOU window.
    const { size } = await stat(skillPath);
    if (size > MAX_SKILL_BYTES) {
      throw new Error(`Skill "${name}" exceeds the ${MAX_SKILL_BYTES}-byte safety limit`);
    }
    const content = await readFile(skillPath, "utf8");
    return textResult(
      `<skill_content name="${entry.name}">\n<skill_instructions>\n${content}\n</skill_instructions>\n</skill_content>`,
      { name: entry.name, source: entry.source ?? skillPath },
    );
  }

  async propose(entry: CapabilityEntry | undefined): Promise<CallToolResult> {
    if (!entry) throw new Error('Action "propose" requires entry');
    const proposal = await this.repository.saveProposal(entry);
    return jsonResult({
      proposal: proposal as unknown as JsonValue,
      executable: false,
      nextStep: `A human must review and run capability-hub-admin approve ${proposal.id} --catalog "${this.repository.catalogPath}" --state "${this.repository.stateDir}" --yes`,
    });
  }

  // The full documents are for the human reviewing them on disk. Returning every one in
  // full measured a 170 MB payload after a proposal loop — a context bomb by any measure.
  async listProposals(): Promise<CallToolResult> {
    const all = await this.repository.proposals();
    const limited = all.slice(0, MAX_PROPOSAL_RESULTS);
    return jsonResult({
      proposals: limited.map((proposal) => ({
        id: proposal.id,
        createdAt: proposal.createdAt,
        kind: proposal.entry.kind,
        name: proposal.entry.name,
        description: proposal.entry.description.slice(0, MAX_FIELD_CHARS),
      })),
      total: all.length,
      truncated: limited.length !== all.length,
    });
  }

  // Removing an entry, or clearing its trusted flag, is how an operator revokes a
  // compromised server. That did nothing while it was running: the live map held its own
  // reference to the old entry, so the revoked capability kept answering calls.
  async reloadCatalog(): Promise<CallToolResult> {
    await this.repository.load();
    const stopped: string[] = [];
    for (const [name, live] of [...this.#live]) {
      const fresh = this.repository.get(name);
      const revoked = !fresh
        || fresh.kind !== "mcp"
        || !fresh.trusted
        || JSON.stringify(fresh.transport) !== JSON.stringify(live.entry.transport);
      if (revoked) {
        stopped.push(name);
        await this.disable(name);
      }
    }
    return jsonResult({ reloaded: true, entries: this.repository.all().length, stopped });
  }

  async close(): Promise<void> {
    // A start still in flight would finish after this and leave an untracked child,
    // so settle those first and close whatever they registered.
    await Promise.allSettled([...this.#starting.values()]);
    const clients = [...this.#live.values()];
    this.#live.clear();
    this.#starting.clear();
    await Promise.allSettled(clients.map(async (live) => await live.client.close()));
  }

  private requireEntry(name: string): CapabilityEntry {
    const entry = this.repository.get(name);
    if (!entry) throw new Error(`Unknown capability "${name}"`);
    return entry;
  }

  private requireMcp(name: string): McpCapabilityEntry {
    const entry = this.requireEntry(name);
    if (entry.kind !== "mcp") throw new Error(`Capability "${name}" is a skill, not an MCP server`);
    return entry;
  }

  private requireSkill(name: string): SkillCapabilityEntry {
    const entry = this.requireEntry(name);
    if (entry.kind !== "skill") throw new Error(`Capability "${name}" is an MCP server, not a skill`);
    return entry;
  }

  private createTransport(entry: McpCapabilityEntry, config: Record<string, JsonValue>) {
    const transport = entry.transport;
    if (transport.type === "stdio") {
      const missing = (transport.requiredEnv ?? []).filter((name) => !process.env[name]);
      if (missing.length > 0) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
      const env = {
        ...getDefaultEnvironment(),
        ...Object.fromEntries((transport.requiredEnv ?? []).map((name) => [name, process.env[name] as string])),
        ...Object.fromEntries(
          Object.entries(transport.env ?? {}).map(([key, value]) => {
            if (LOADER_ENV.test(key)) {
              throw new Error(`Environment variable "${key}" can load code into the child and cannot be set from a catalog entry`);
            }
            return [key, this.repository.resolveTemplate(value, config)];
          }),
        ),
      };
      return new StdioClientTransport({
        command: this.repository.resolveExecutableTemplate(transport.command),
        args: (transport.args ?? []).map((value) => this.repository.resolveTemplate(value, config)),
        env,
        ...(transport.cwd
          ? { cwd: this.repository.resolveExecutableTemplate(transport.cwd) }
          : {}),
        stderr: "inherit",
      });
    }

    const headers = Object.fromEntries(
      Object.entries(transport.headersFromEnv ?? {}).map(([header, definition]) => {
        const value = process.env[definition.env];
        if (!value) throw new Error(`Missing required environment variable: ${definition.env}`);
        return [header, `${definition.prefix ?? ""}${value}`];
      }),
    );
    return new StreamableHTTPClientTransport(
      new URL(this.repository.resolveTemplate(transport.url, config)),
      { requestInit: { headers } },
    );
  }

  private async collectTools(client: Client): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }
}
