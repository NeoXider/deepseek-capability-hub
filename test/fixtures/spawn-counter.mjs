// Records its own PID, then becomes the real fixture server. Used to count how many
// child processes a capability actually spawned, which the hub's own state cannot show
// when a process is leaked untracked.
import { appendFileSync } from "node:fs";

appendFileSync(process.env.HUB_SPAWN_LOG, `${process.pid}\n`);
await import(process.env.HUB_REAL_ENTRY);
