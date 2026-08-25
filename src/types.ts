export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface CatalogDocument {
  version: 1;
  entries: CapabilityEntry[];
}

export interface CapabilityBase {
  kind: "mcp" | "skill";
  name: string;
  description: string;
  tags?: string[];
  trusted: boolean;
  source?: string;
  permissions?: string[];
}

export interface StdioTransportDefinition {
  type: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  requiredEnv?: string[];
  env?: Record<string, string>;
}

export interface HttpHeaderDefinition {
  env: string;
  prefix?: string;
}

export interface HttpTransportDefinition {
  type: "streamable-http";
  url: string;
  headersFromEnv?: Record<string, HttpHeaderDefinition>;
}

export interface McpCapabilityEntry extends CapabilityBase {
  kind: "mcp";
  transport: StdioTransportDefinition | HttpTransportDefinition;
  configurable?: string[];
}

export interface SkillCapabilityEntry extends CapabilityBase {
  kind: "skill";
  skill: {
    type: "file";
    path: string;
  };
}

export type CapabilityEntry = McpCapabilityEntry | SkillCapabilityEntry;

export interface HubInput {
  action:
    | "search"
    | "inspect"
    | "status"
    | "configure"
    | "enable"
    | "disable"
    | "tools"
    | "call"
    | "skill.load"
    | "propose"
    | "proposals"
    | "catalog.reload";
  query?: string;
  kind?: "mcp" | "skill";
  name?: string;
  tool?: string;
  arguments?: Record<string, JsonValue>;
  config?: Record<string, JsonValue>;
  includeSchema?: boolean;
  entry?: CapabilityEntry;
}

export interface ProposalDocument {
  id: string;
  createdAt: string;
  entry: CapabilityEntry;
}

export interface PersistedConfig {
  version: 1;
  capabilities: Record<string, Record<string, JsonValue>>;
}
