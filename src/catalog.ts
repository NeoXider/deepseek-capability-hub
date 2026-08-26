import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  catalogDocumentSchema,
  capabilityEntrySchema,
  persistedConfigSchema,
  proposalDocumentSchema,
} from "./schema.js";
import type {
  CapabilityEntry,
  CatalogDocument,
  JsonValue,
  PersistedConfig,
  ProposalDocument,
  SkillCapabilityEntry,
} from "./types.js";

const EMPTY_CONFIG: PersistedConfig = { version: 1, capabilities: {} };

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readJsonIfExists(filePath: string): Promise<unknown | undefined> {
  try {
    return await readJson(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

function assertUnique(entries: readonly CapabilityEntry[]): void {
  const names = new Set<string>();
  for (const entry of entries) {
    if (names.has(entry.name)) throw new Error(`Duplicate capability name: ${entry.name}`);
    names.add(entry.name);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export class CatalogRepository {
  readonly catalogPath: string;
  readonly stateDir: string;
  readonly catalogDir: string;
  readonly packageDir: string;

  #entries = new Map<string, CapabilityEntry>();
  #configs: PersistedConfig = structuredClone(EMPTY_CONFIG);

  constructor(catalogPath: string, stateDir: string) {
    this.catalogPath = path.resolve(catalogPath);
    this.stateDir = path.resolve(stateDir);
    this.catalogDir = path.dirname(this.catalogPath);
    this.packageDir =
      path.basename(this.catalogDir).toLocaleLowerCase() === "data"
        ? path.resolve(this.catalogDir, "..")
        : this.catalogDir;
  }

  async load(): Promise<void> {
    const base = catalogDocumentSchema.parse(await readJson(this.catalogPath)) as CatalogDocument;
    const approvedRaw = await readJsonIfExists(path.join(this.stateDir, "approved.json"));
    const approved = approvedRaw
      ? (catalogDocumentSchema.parse(approvedRaw) as CatalogDocument)
      : ({ version: 1, entries: [] } satisfies CatalogDocument);
    const combined = [...base.entries, ...approved.entries];
    assertUnique(combined);
    this.#entries = new Map(combined.map((entry) => [entry.name, entry]));

    const configRaw = await readJsonIfExists(path.join(this.stateDir, "config.json"));
    this.#configs = configRaw
      ? (persistedConfigSchema.parse(configRaw) as PersistedConfig)
      : structuredClone(EMPTY_CONFIG);
  }

  all(): CapabilityEntry[] {
    return [...this.#entries.values()];
  }

  get(name: string): CapabilityEntry | undefined {
    return this.#entries.get(name);
  }

  search(query = "", kind?: "mcp" | "skill"): CapabilityEntry[] {
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return this.all()
      .filter((entry) => kind === undefined || entry.kind === kind)
      .filter((entry) => {
        const text = [entry.name, entry.description, ...(entry.tags ?? [])].join(" ").toLocaleLowerCase();
        return terms.every((term) => text.includes(term));
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  configFor(name: string): Record<string, JsonValue> {
    return structuredClone(this.#configs.capabilities[name] ?? {});
  }

  async setConfig(name: string, config: Record<string, JsonValue>): Promise<void> {
    this.#configs.capabilities[name] = structuredClone(config);
    await writeJsonAtomic(path.join(this.stateDir, "config.json"), this.#configs);
  }

  resolveTemplate(value: string, config: Record<string, JsonValue>): string {
    return value.replace(/\$\{(catalogDir|packageDir|config:([A-Za-z0-9_.-]+))\}/g, (_match, token, key) => {
      if (token === "catalogDir") return this.catalogDir;
      if (token === "packageDir") return this.packageDir;
      const configured = config[key as string];
      if (typeof configured !== "string" && typeof configured !== "number" && typeof configured !== "boolean") {
        throw new Error(`Configuration key "${String(key)}" is required and must be scalar`);
      }
      return String(configured);
    });
  }

  // The executable itself must never come from model-supplied configuration, even if
  // an operator allowlisted the key: directory tokens are fine, ${config:...} is not.
  resolveExecutableTemplate(value: string): string {
    if (/\$\{config:/.test(value)) {
      throw new Error("A transport command cannot interpolate ${config:...}; put configurable values in args or env");
    }
    return this.resolveTemplate(value, {});
  }

  async resolveTrustedSkillPath(entry: SkillCapabilityEntry): Promise<string> {
    if (!entry.trusted) throw new Error(`Skill "${entry.name}" is untrusted and cannot be loaded`);
    const candidate = await realpath(this.resolveTemplate(entry.skill.path, {}));
    const configuredRoots = entry.skill.allowedRoots ?? [];
    const roots = await Promise.all(
      [this.catalogDir, this.packageDir, ...configuredRoots].map(async (root) => {
        return await realpath(this.resolveTemplate(root, {}));
      }),
    );
    if (!roots.some((root) => isWithin(root, candidate))) {
      throw new Error(
        `Skill "${entry.name}" resolves outside its trusted roots; approve an explicit skill.allowedRoots entry first`,
      );
    }
    return candidate;
  }

  async saveProposal(entryInput: CapabilityEntry): Promise<ProposalDocument> {
    const parsed = capabilityEntrySchema.parse({ ...entryInput, trusted: false }) as CapabilityEntry;
    const proposal: ProposalDocument = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      entry: parsed,
    };
    await writeJsonAtomic(path.join(this.stateDir, "pending", `${proposal.id}.json`), proposal);
    return proposal;
  }

  async proposals(): Promise<ProposalDocument[]> {
    const directory = path.join(this.stateDir, "pending");
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const proposals = await Promise.all(
      names
        .filter((name) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.json$/i.test(name))
        .map(async (name) => {
          return proposalDocumentSchema.parse(await readJson(path.join(directory, name))) as ProposalDocument;
        }),
    );
    return proposals.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async approve(proposalId: string): Promise<ProposalDocument> {
    // The id becomes a filename, so it is constrained to the UUID shape that
    // saveProposal generates instead of being trusted as an operator-typed string.
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(proposalId)) {
      throw new Error(`"${proposalId}" is not a valid proposal id`);
    }
    const pendingPath = path.join(this.stateDir, "pending", `${proposalId}.json`);
    const proposal = proposalDocumentSchema.parse(await readJson(pendingPath)) as ProposalDocument;
    const entry = capabilityEntrySchema.parse({ ...proposal.entry, trusted: true }) as CapabilityEntry;
    const base = catalogDocumentSchema.parse(await readJson(this.catalogPath)) as CatalogDocument;
    const approvedPath = path.join(this.stateDir, "approved.json");
    const currentRaw = await readJsonIfExists(approvedPath);
    const current = currentRaw
      ? (catalogDocumentSchema.parse(currentRaw) as CatalogDocument)
      : ({ version: 1, entries: [] } satisfies CatalogDocument);
    assertUnique([...base.entries, ...current.entries]);
    if ([...base.entries, ...current.entries].some((candidate) => candidate.name === entry.name)) {
      throw new Error(`Capability "${entry.name}" conflicts with the base or approved catalog`);
    }
    await writeJsonAtomic(approvedPath, { version: 1, entries: [...current.entries, entry] });
    await rename(pendingPath, path.join(this.stateDir, "pending", `${proposalId}.approved.json`));
    return { ...proposal, entry };
  }
}
