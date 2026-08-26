#!/usr/bin/env node
import path from "node:path";
import { CatalogRepository } from "./catalog.js";

function argumentValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positionalArguments(): string[] {
  const valueFlags = new Set(["--state", "--catalog"]);
  const positional: string[] = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument === undefined) continue;
    if (valueFlags.has(argument)) {
      index += 1;
      continue;
    }
    if (!argument.startsWith("--")) positional.push(argument);
  }
  return positional;
}

async function main(): Promise<void> {
  const [command, id] = positionalArguments();
  const stateDir = path.resolve(argumentValue("--state") ?? path.join(process.cwd(), "data", "state"));
  const catalogPath = path.resolve(
    argumentValue("--catalog") ?? path.join(process.cwd(), "data", "catalog.json"),
  );

  if (command !== "approve" || !id) {
    throw new Error(
      'Usage: capability-hub-admin approve <proposal-id> --catalog "<catalog.json>" --state "<state-dir>" --yes',
    );
  }
  if (!process.argv.includes("--yes")) {
    throw new Error("Approval requires --yes after a human reviews the pending proposal JSON");
  }
  const repository = new CatalogRepository(catalogPath, stateDir);
  const approved = await repository.approve(id);
  process.stdout.write(`${JSON.stringify(approved, null, 2)}\n`);
  process.stdout.write("Approved. Ask the model to run catalog.reload before enabling it.\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
