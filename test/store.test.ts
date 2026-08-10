import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.js";

test("sessions and agent runs survive reopening the store", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-store-"));
  try {
    const first = new Store(join(directory, "state.db"));
    first.createSession("hash", Date.now() + 60_000);
    const created = first.createRun("finish the task");
    created.status = "running";
    created.step = 2;
    first.updateRun(created);

    const reopened = new Store(join(directory, "state.db"));
    assert.equal(reopened.validSession("hash"), true);
    assert.equal(reopened.getRun(created.id)?.objective, "finish the task");
    assert.equal(reopened.resumableRuns()[0]?.step, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
