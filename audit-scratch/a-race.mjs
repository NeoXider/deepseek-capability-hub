import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import os from "node:os"; import path from "node:path";
import { CatalogRepository } from "../dist/src/catalog.js";
import { CapabilityHub } from "../dist/src/manager.js";

const fixture = path.resolve("pidfixture.mjs");
const root = await mkdtemp(path.join(os.tmpdir(), "audit-race-"));
const pidfile = path.join(root, "pids.txt");
await writeFile(pidfile, "");
const catalogPath = path.join(root, "catalog.json");
await writeFile(catalogPath, JSON.stringify({version:1,entries:[{
  kind:"mcp", name:"echo-test", description:"t", trusted:true,
  transport:{type:"stdio",command:process.execPath,args:[fixture],env:{AUDIT_PIDFILE:pidfile}}, configurable:[]}]}));

const repo = new CatalogRepository(catalogPath, path.join(root,"state"));
await repo.load();
const hub = new CapabilityHub(repo);
const sig = new AbortController().signal;
const alive = p => { try { process.kill(p, 0); return true; } catch { return false; } };
const pids = async () => (await readFile(pidfile,"utf8")).split("\n").filter(Boolean).map(Number);

const [r1, r2] = await Promise.all([
  hub.execute({action:"enable",name:"echo-test"}, sig),
  hub.execute({action:"enable",name:"echo-test"}, sig)]);
console.log("enable#1:", r1.content[0].text);
console.log("enable#2:", r2.content[0].text);
console.log("child PIDs spawned:", await pids());
console.log("status:", (await hub.execute({action:"status"}, sig)).content[0].text);
console.log("disable:", (await hub.execute({action:"disable",name:"echo-test"}, sig)).content[0].text);
await hub.close();
await new Promise(r => setTimeout(r, 3000));
const list = await pids();
console.log("alive after disable+close:", list.map(p => `${p}=${alive(p)}`).join(" "));
for (const p of list) { try { process.kill(p); } catch {} }
process.exit(0);
