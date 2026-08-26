import { readFile } from "node:fs/promises";
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
        return jsonResult({ proposals: (await this.repository.proposals()) as unknown as JsonValue });
      case "catalog.reload":
        await this.repository.load();
        return jsonResult({ reloaded: true, entries: this.repository.all().length });
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

  async enable(name: string): Promise<JsonValue> {
    const existing = this.#live.get(name);
    if (existing) return { enabled: name, alreadyEnabled: true, tools: existing.tools.length };

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
    const result = await live.client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { signal },
    );
    if (!("content" in result) || !Array.isArray(result.content)) {
      return textResult(JSON.stringify("toolResult" in result ? result.toolResult : result));
    }
    return result as CallToolResult;
  }

  async loadSkill(name: string): Promise<CallToolResult> {
    const entry = this.requireSkill(name);
    const skillPath = await this.repository.resolveTrustedSkillPath(entry);
    const content = await readFile(skillPath, "utf8");
    if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) {
      throw new Error(`Skill "${name}" exceeds the ${MAX_SKILL_BYTES}-byte safety limit`);
    }
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

  async close(): Promise<void> {
    const clients = [...this.#live.values()];
    this.#live.clear();
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
          Object.entries(transport.env ?? {}).map(([key, value]) => [
            key,
            this.repository.resolveTemplate(value, config),
          ]),
        ),
      };
      return new StdioClientTransport({
        command: this.repository.resolveTemplate(transport.command, config),
        args: (transport.args ?? []).map((value) => this.repository.resolveTemplate(value, config)),
        env,
        ...(transport.cwd
          ? { cwd: this.repository.resolveTemplate(transport.cwd, config) }
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
