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

test("sessions, workflows, and usage are isolated by user", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-users-"));
  try {
    const store = new Store(join(directory, "state.db"));
    store.upsertUser({ id: "puter:alice", provider: "puter", externalId: "alice", displayName: "Alice" });
    store.upsertUser({ id: "puter:bob", provider: "puter", externalId: "bob", displayName: "Bob" });
    store.createSession("alice-session", Date.now() + 60_000, "puter:alice");
    assert.equal(store.sessionUser("alice-session"), "puter:alice");
    const aliceRun = store.createRun("alice objective", "puter:alice");
    store.createRun("bob objective", "puter:bob");
    assert.equal(store.listRuns(50, "puter:alice").length, 1);
    assert.equal(store.listRuns(50, "puter:bob").length, 1);
    assert.equal(store.getRun(aliceRun.id, "puter:bob"), undefined);
    store.recordUsage({ userId: "puter:alice", providerId: "puter", modelId: "auto", endpoint: "chat", totalTokens: 12, status: 200, latencyMs: 1 });
    assert.equal(store.usageSummary("2000-01-01", "puter:alice")[0]?.total_tokens, 12);
    assert.equal(store.usageSummary("2000-01-01", "puter:bob").length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
