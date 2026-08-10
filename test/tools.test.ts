import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { builtInTools } from "../src/tools.js";

test("workspace tools write and read inside the root but reject traversal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-tools-"));
  try {
    const tools = builtInTools(directory);
    const write = tools.find((tool) => tool.definition.function.name === "write_file");
    const read = tools.find((tool) => tool.definition.function.name === "read_file");
    assert.ok(write && read);
    await write.execute(JSON.stringify({ path: "notes/result.txt", content: "evidence" }));
    assert.equal(await read.execute(JSON.stringify({ path: "notes/result.txt" })), "evidence");
    await assert.rejects(() => write.execute(JSON.stringify({ path: "../escape.txt", content: "no" })), /escapes/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
