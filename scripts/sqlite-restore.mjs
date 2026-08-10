import { createWriteStream, existsSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

const dataDirectory = resolve(process.env.HARNESS_DATA_DIR ?? ".harness");
const databasePath = resolve(dataDirectory, "state.db");
const incomingPath = resolve(dataDirectory, `.restore-${process.pid}.db`);

await new Promise((resolveStream, reject) => {
  const output = createWriteStream(incomingPath, { mode: 0o600, flags: "wx" });
  process.stdin.on("error", reject);
  output.on("error", reject);
  output.on("finish", resolveStream);
  process.stdin.pipe(output);
});

try {
  const candidate = new DatabaseSync(incomingPath, { readOnly: true });
  const result = candidate.prepare("PRAGMA integrity_check").get();
  candidate.close();
  if (!result || Object.values(result)[0] !== "ok") throw new Error("backup failed SQLite integrity_check");

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  let previousPath;
  if (existsSync(databasePath)) {
    previousPath = `${databasePath}.before-restore-${timestamp}`;
    const current = new DatabaseSync(databasePath, { readOnly: true });
    try {
      await backup(current, previousPath);
    } finally {
      current.close();
    }
  }
  for (const suffix of ["-wal", "-shm"]) rmSync(`${databasePath}${suffix}`, { force: true });
  // On the Linux production target rename replaces the directory entry atomically,
  // so readers never observe a missing database between removal and installation.
  renameSync(incomingPath, databasePath);
  console.error(previousPath ? `restore complete; previous database snapshot retained at ${previousPath}` : "restore complete");
} catch (error) {
  rmSync(incomingPath, { force: true });
  throw error;
}
