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

test("separate store connections preserve concurrent users without cross-account data loss", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-store-concurrency-"));
  try {
    const path = join(directory, "state.db");
    const first = new Store(path);
    const second = new Store(path);
    await Promise.all([
      Promise.resolve().then(() => {
        for (let index = 0; index < 40; index += 1) {
          first.createRun(`alice objective ${index}`, "puter:alice");
          first.recordUsage({ userId: "puter:alice", providerId: "puter", modelId: "auto", endpoint: "chat", totalTokens: 1, status: 200, latencyMs: 1 });
        }
      }),
      Promise.resolve().then(() => {
        for (let index = 0; index < 40; index += 1) {
          second.createRun(`bob objective ${index}`, "puter:bob");
          second.recordUsage({ userId: "puter:bob", providerId: "puter", modelId: "auto", endpoint: "chat", totalTokens: 1, status: 200, latencyMs: 1 });
        }
      }),
    ]);
    assert.equal(first.listRuns(100, "puter:alice").length, 40);
    assert.equal(second.listRuns(100, "puter:bob").length, 40);
    assert.equal(first.usageSummary("2000-01-01", "puter:alice")[0]?.total_tokens, 40);
    assert.equal(second.usageSummary("2000-01-01", "puter:bob")[0]?.total_tokens, 40);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("updating a run cannot transfer its ownership or rewrite its original objective", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-run-ownership-"));
  try {
    const store = new Store(join(directory, "state.db"));
    const run = store.createRun("original objective", "puter:alice");
    run.userId = "puter:bob";
    run.objective = "rewritten objective";
    run.status = "completed";
    store.updateRun(run);

    assert.equal(store.getRun(run.id, "puter:bob"), undefined);
    const persisted = store.getRun(run.id, "puter:alice");
    assert.equal(persisted?.objective, "original objective");
    assert.equal(persisted?.status, "completed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("active workflow counts include only queued and running runs for the requested user", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-active-runs-"));
  try {
    const store = new Store(join(directory, "state.db"));
    const queued = store.createRun("queued", "puter:alice");
    const running = store.createRun("running", "puter:alice");
    running.status = "running";
    store.updateRun(running);
    const completed = store.createRun("completed", "puter:alice");
    completed.status = "completed";
    store.updateRun(completed);
    const failed = store.createRun("failed", "puter:alice");
    failed.status = "failed";
    store.updateRun(failed);
    store.createRun("bob queued", "puter:bob");

    assert.equal(store.activeRunCount("puter:alice"), 2);
    assert.equal(store.activeRunCount("puter:bob"), 1);
    queued.status = "cancelled";
    store.updateRun(queued);
    assert.equal(store.activeRunCount("puter:alice"), 1);
    assert.equal(store.ping(), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
