import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("workspace writes cannot follow a file symlink outside the managed root", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-tools-symlink-"));
  const workspace = join(directory, "workspace");
  const outside = join(directory, "outside.txt");
  try {
    writeFileSync(outside, "untouched", { mode: 0o600 });
    const tools = builtInTools(workspace);
    const write = tools.find((tool) => tool.definition.function.name === "write_file");
    assert.ok(write);
    symlinkSync(outside, join(workspace, "linked.txt"));

    await assert.rejects(
      () => write.execute(JSON.stringify({ path: "linked.txt", content: "escaped" })),
      /symlink|escapes/i,
    );
    assert.equal(readFileSync(outside, "utf8"), "untouched");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tool policy independently removes network, workspace, and execution capabilities", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-tool-policy-"));
  try {
    const names = (options: Parameters<typeof builtInTools>[1]) => builtInTools(directory, options).map((tool) => tool.definition.function.name);
    assert.deepEqual(names({ allowNetwork: false }), ["current_time", "chess_square_color", "list_files", "read_file", "write_file", "run_tests"]);
    assert.deepEqual(names({ allowWorkspace: false }), ["current_time", "chess_square_color", "http_get", "web_search"]);
    assert.deepEqual(names({ allowExecution: false }), ["current_time", "chess_square_color", "http_get", "web_search", "list_files", "read_file", "write_file"]);
    assert.deepEqual(names({ allowNetwork: false, allowWorkspace: false, allowExecution: false }), ["current_time", "chess_square_color"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("run_tests receives a minimal environment without harness or provider secrets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-test-env-"));
  const project = join(directory, "project");
  const previousHarnessSecret = process.env.HARNESS_VAULT_KEY;
  const previousProviderSecret = process.env.NVIDIA_API_KEY;
  try {
    mkdirSync(project);
    writeFileSync(join(project, "package.json"), JSON.stringify({
      scripts: {
        test: "node -e \"console.log(JSON.stringify({h:process.env.HARNESS_VAULT_KEY,n:process.env.NVIDIA_API_KEY,ci:process.env.CI,node:process.env.NODE_ENV}))\"",
      },
    }));
    process.env.HARNESS_VAULT_KEY = "must-never-reach-child";
    process.env.NVIDIA_API_KEY = "must-never-reach-child-either";
    const runTests = builtInTools(directory).find((tool) => tool.definition.function.name === "run_tests");
    assert.ok(runTests);
    const output = await runTests.execute(JSON.stringify({ path: "project" }));
    assert.doesNotMatch(output, /must-never-reach-child/);
    assert.match(output, /\{"ci":"true","node":"test"\}/);
  } finally {
    if (previousHarnessSecret === undefined) delete process.env.HARNESS_VAULT_KEY;
    else process.env.HARNESS_VAULT_KEY = previousHarnessSecret;
    if (previousProviderSecret === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = previousProviderSecret;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("network tools reject IPv4-mapped IPv6 loopback literals", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-tool-network-"));
  try {
    const httpGet = builtInTools(directory).find((tool) => tool.definition.function.name === "http_get");
    assert.ok(httpGet);
    await assert.rejects(
      () => httpGet.execute(JSON.stringify({ url: "http://[::ffff:127.0.0.1]/private" })),
      /Private or local network targets are blocked/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
