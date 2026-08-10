import { createReadStream, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";

const sourcePath = resolve(process.env.HARNESS_DATA_DIR ?? ".harness", "state.db");
const temporaryPath = resolve(tmpdir(), `free-ai-harness-${randomUUID()}.db`);
const source = new DatabaseSync(sourcePath, { readOnly: true });

try {
  await backup(source, temporaryPath);
  source.close();
  await new Promise((resolveStream, reject) => {
    const stream = createReadStream(temporaryPath);
    stream.on("error", reject);
    stream.on("end", resolveStream);
    stream.pipe(process.stdout, { end: false });
  });
} finally {
  try { source.close(); } catch {}
  rmSync(temporaryPath, { force: true });
}
