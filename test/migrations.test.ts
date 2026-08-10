import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Store } from "../src/store.js";

test("legacy single-user databases migrate sessions, runs, and usage to the operator", () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-migration-"));
  const path = join(directory, "state.db");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, objective TEXT NOT NULL, messages_json TEXT NOT NULL,
        events_json TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
        endpoint TEXT NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
        status INTEGER NOT NULL, latency_ms REAL NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE model_feedback (
        run_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
        rating INTEGER NOT NULL CHECK(rating IN (-1, 1)), created_at TEXT NOT NULL
      );
    `);
    const now = new Date().toISOString();
    legacy.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run("legacy-session", Date.now() + 60_000, Date.now());
    legacy.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "legacy-run", "running", "legacy objective", '[{"role":"user","content":"legacy objective"}]', "[]", 3, null, null, now, now,
    );
    legacy.prepare("INSERT INTO usage_events(provider_id, model_id, endpoint, total_tokens, status, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("legacy-provider", "legacy-model", "chat", 9, 200, 1, now);
    legacy.prepare("INSERT INTO model_feedback VALUES (?, ?, ?, ?, ?)").run("legacy-feedback", "legacy-provider", "legacy-model", 1, now);
    legacy.close();

    const migrated = new Store(path);
    assert.equal(migrated.sessionUser("legacy-session"), "operator");
    assert.equal(migrated.getRun("legacy-run", "operator")?.step, 3);
    assert.equal(migrated.getRun("legacy-run", "puter:alice"), undefined);
    assert.equal(migrated.usageSummary("2000-01-01", "operator")[0]?.total_tokens, 9);
    assert.deepEqual(migrated.providerFeedbackAdjustments("operator"), { "legacy-provider": 1 });
    assert.deepEqual(migrated.providerFeedbackAdjustments("puter:alice"), {});

    const alice = migrated.createRun("new user objective", "puter:alice");
    assert.equal(migrated.getRun(alice.id, "operator"), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
