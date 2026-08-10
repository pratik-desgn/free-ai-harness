import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
    first.upsertUser({ id: "puter:alice", provider: "puter", externalId: "alice", displayName: "Alice" });
    first.upsertUser({ id: "puter:bob", provider: "puter", externalId: "bob", displayName: "Bob" });
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

test("feedback adjustments are isolated by tenant", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-feedback-tenants-"));
  try {
    const store = new Store(join(directory, "state.db"));
    store.recordFeedback("alice-run-1", "puter", "model-a", 1, "puter:alice");
    store.recordFeedback("alice-run-2", "puter", "model-a", 1, "puter:alice");
    store.recordFeedback("bob-run-1", "puter", "model-a", -1, "puter:bob");
    store.recordFeedback("bob-run-2", "other", "model-b", 1, "puter:bob");

    assert.deepEqual(store.providerFeedbackAdjustments("puter:alice"), { puter: 2 });
    assert.deepEqual(store.providerFeedbackAdjustments("puter:bob"), { other: 1, puter: -1 });
    assert.deepEqual(store.providerFeedbackAdjustments("operator"), {});
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("account deletion removes one tenant's complete footprint without affecting another tenant", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-account-delete-"));
  const path = join(directory, "state.db");
  try {
    const store = new Store(path);
    for (const user of ["alice", "bob"]) {
      store.upsertUser({ id: `puter:${user}`, provider: "puter", externalId: user, displayName: user });
      store.createSession(`${user}-session`, Date.now() + 60_000, `puter:${user}`);
      store.recordConsent(`puter:${user}`, "puter-terms", "v1");
      store.setUserProviderSecret(`puter:${user}`, "puter", `${user}-cipher`, `${user}-iv`, `${user}-tag`);
      store.createRun(`${user} objective`, `puter:${user}`);
      store.recordUsage({ userId: `puter:${user}`, providerId: "puter", modelId: "auto", endpoint: "chat", totalTokens: 5, status: 200, latencyMs: 1 });
      store.recordFeedback(`${user}-feedback`, "puter", "auto", user === "alice" ? 1 : -1, `puter:${user}`);
      store.cacheSet(`puter:${user}:cache`, { providerId: "puter", modelId: "auto", body: user, contentType: "application/json" }, 60_000);
    }
    store.setProviderSecret("operator-provider", "cipher", "iv", "tag");

    store.deleteUserAccount("puter:alice");
    store.recordUsage({ userId: "puter:alice", providerId: "late-provider", modelId: "late-model", endpoint: "chat", totalTokens: 99, status: 200, latencyMs: 1 });

    assert.equal(store.getUser("puter:alice"), undefined);
    assert.equal(store.sessionUser("alice-session"), undefined);
    assert.deepEqual(store.userProviderSecrets("puter:alice"), []);
    assert.deepEqual(store.listRuns(50, "puter:alice"), []);
    assert.deepEqual(store.usageSummary("1970-01-01", "puter:alice"), []);
    assert.deepEqual(store.providerFeedbackAdjustments("puter:alice"), {});
    assert.equal(store.cacheGet("puter:alice:cache"), undefined);

    assert.equal(store.getUser("puter:bob")?.externalId, "bob");
    assert.equal(store.sessionUser("bob-session"), "puter:bob");
    assert.equal(store.userProviderSecrets("puter:bob").length, 1);
    assert.equal(store.listRuns(50, "puter:bob").length, 1);
    assert.equal(store.tokensUsedSince("puter:bob", "1970-01-01"), 5);
    assert.deepEqual(store.providerFeedbackAdjustments("puter:bob"), { puter: -1 });
    assert.equal(store.cacheGet("puter:bob:cache")?.body, "bob");
    assert.equal(store.providerSecrets().length, 1);

    const inspection = new DatabaseSync(path, { readOnly: true });
    const aliceConsents = inspection.prepare("SELECT COUNT(*) AS count FROM user_consents WHERE user_id = ?").get("puter:alice") as { count: number };
    const bobConsents = inspection.prepare("SELECT COUNT(*) AS count FROM user_consents WHERE user_id = ?").get("puter:bob") as { count: number };
    assert.equal(aliceConsents.count, 0);
    assert.equal(bobConsents.count, 1);
    inspection.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("logout-all invalidates every session for only the requested user", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-logout-all-"));
  try {
    const store = new Store(join(directory, "state.db"));
    store.createSession("alice-one", Date.now() + 60_000, "puter:alice");
    store.createSession("alice-two", Date.now() + 60_000, "puter:alice");
    store.createSession("bob-one", Date.now() + 60_000, "puter:bob");
    store.deleteSessionsForUser("puter:alice");
    assert.equal(store.sessionUser("alice-one"), undefined);
    assert.equal(store.sessionUser("alice-two"), undefined);
    assert.equal(store.sessionUser("bob-one"), "puter:bob");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
