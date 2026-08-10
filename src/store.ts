import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentRun, ChatMessage, RunEvent, RunStatus } from "./types.js";

interface RunRow {
  id: string;
  status: RunStatus;
  objective: string;
  messages_json: string;
  events_json: string;
  step: number;
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export class Store {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.database = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        objective TEXT NOT NULL,
        messages_json TEXT NOT NULL,
        events_json TEXT NOT NULL,
        step INTEGER NOT NULL DEFAULT 0,
        result TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_secrets (
        provider_id TEXT PRIMARY KEY,
        ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        status INTEGER NOT NULL,
        latency_ms REAL NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_events_created ON usage_events(created_at);
      CREATE TABLE IF NOT EXISTS response_cache (
        cache_key TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        body TEXT NOT NULL,
        content_type TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_feedback (
        run_id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        rating INTEGER NOT NULL CHECK(rating IN (-1, 1)),
        created_at TEXT NOT NULL
      );
    `);
  }

  createSession(tokenHash: string, expiresAt: number): void {
    this.database.prepare("INSERT INTO sessions(token_hash, expires_at, created_at) VALUES (?, ?, ?)").run(tokenHash, expiresAt, Date.now());
  }

  validSession(tokenHash: string, now = Date.now()): boolean {
    const row = this.database.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").get(tokenHash) as { expires_at: number } | undefined;
    return row !== undefined && row.expires_at > now;
  }

  deleteSession(tokenHash: string): void {
    this.database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  pruneSessions(now = Date.now()): void {
    this.database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  }

  setProviderSecret(providerId: string, ciphertext: string, iv: string, authTag: string): void {
    this.database.prepare(`
      INSERT INTO provider_secrets(provider_id, ciphertext, iv, auth_tag, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET ciphertext=excluded.ciphertext, iv=excluded.iv, auth_tag=excluded.auth_tag, updated_at=excluded.updated_at
    `).run(providerId, ciphertext, iv, authTag, new Date().toISOString());
  }

  providerSecrets(): Array<{ providerId: string; ciphertext: string; iv: string; authTag: string }> {
    const rows = this.database.prepare("SELECT provider_id, ciphertext, iv, auth_tag FROM provider_secrets").all() as unknown as Array<{
      provider_id: string; ciphertext: string; iv: string; auth_tag: string;
    }>;
    return rows.map((row) => ({ providerId: row.provider_id, ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag }));
  }

  deleteProviderSecret(providerId: string): void {
    this.database.prepare("DELETE FROM provider_secrets WHERE provider_id = ?").run(providerId);
  }

  recordUsage(event: {
    providerId: string; modelId: string; endpoint: string; promptTokens?: number; completionTokens?: number;
    totalTokens?: number; status: number; latencyMs: number;
  }): void {
    this.database.prepare(`
      INSERT INTO usage_events(provider_id, model_id, endpoint, prompt_tokens, completion_tokens, total_tokens, status, latency_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.providerId, event.modelId, event.endpoint, event.promptTokens ?? 0, event.completionTokens ?? 0,
      event.totalTokens ?? 0, event.status, event.latencyMs, new Date().toISOString(),
    );
  }

  usageSummary(since: string): Array<Record<string, unknown>> {
    return this.database.prepare(`
      SELECT provider_id, model_id, COUNT(*) AS requests, SUM(prompt_tokens) AS prompt_tokens,
        SUM(completion_tokens) AS completion_tokens, SUM(total_tokens) AS total_tokens,
        ROUND(AVG(latency_ms), 1) AS average_latency_ms,
        SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS successful_requests
      FROM usage_events WHERE created_at >= ? GROUP BY provider_id, model_id ORDER BY total_tokens DESC, requests DESC
    `).all(since) as unknown as Array<Record<string, unknown>>;
  }

  cacheGet(cacheKey: string, now = Date.now()): { providerId: string; modelId: string; body: string; contentType: string } | undefined {
    this.database.prepare("DELETE FROM response_cache WHERE expires_at <= ?").run(now);
    const row = this.database.prepare("SELECT provider_id, model_id, body, content_type FROM response_cache WHERE cache_key = ?").get(cacheKey) as {
      provider_id: string; model_id: string; body: string; content_type: string;
    } | undefined;
    return row ? { providerId: row.provider_id, modelId: row.model_id, body: row.body, contentType: row.content_type } : undefined;
  }

  cacheSet(cacheKey: string, value: { providerId: string; modelId: string; body: string; contentType: string }, ttlMs: number): void {
    this.database.prepare(`
      INSERT INTO response_cache(cache_key, provider_id, model_id, body, content_type, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET provider_id=excluded.provider_id, model_id=excluded.model_id, body=excluded.body,
        content_type=excluded.content_type, expires_at=excluded.expires_at, created_at=excluded.created_at
    `).run(cacheKey, value.providerId, value.modelId, value.body, value.contentType, Date.now() + ttlMs, Date.now());
  }

  recordFeedback(runId: string, providerId: string, modelId: string, rating: -1 | 1): void {
    this.database.prepare(`
      INSERT INTO model_feedback(run_id, provider_id, model_id, rating, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET provider_id=excluded.provider_id, model_id=excluded.model_id, rating=excluded.rating, created_at=excluded.created_at
    `).run(runId, providerId, modelId, rating, new Date().toISOString());
  }

  providerFeedbackAdjustments(): Record<string, number> {
    const rows = this.database.prepare(`
      SELECT provider_id, AVG(rating) AS average_rating, COUNT(*) AS ratings FROM model_feedback GROUP BY provider_id
    `).all() as unknown as Array<{ provider_id: string; average_rating: number; ratings: number }>;
    return Object.fromEntries(rows.map((row) => [row.provider_id, Math.max(-10, Math.min(10, row.average_rating * Math.min(10, row.ratings))) ]));
  }

  createRun(objective: string): AgentRun {
    const now = new Date().toISOString();
    const run: AgentRun = {
      id: crypto.randomUUID(),
      status: "queued",
      objective,
      messages: [{ role: "user", content: objective }],
      events: [{ at: now, type: "created", message: "Workflow created" }],
      step: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.writeRun(run);
    return run;
  }

  getRun(id: string): AgentRun | undefined {
    const row = this.database.prepare("SELECT * FROM runs WHERE id = ?").get(id) as unknown as RunRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  resumableRuns(): AgentRun[] {
    const rows = this.database.prepare("SELECT * FROM runs WHERE status IN ('queued', 'running') ORDER BY created_at").all() as unknown as RunRow[];
    return rows.map(fromRow);
  }

  listRuns(limit = 50): AgentRun[] {
    const rows = this.database.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?").all(Math.max(1, Math.min(200, limit))) as unknown as RunRow[];
    return rows.map(fromRow);
  }

  updateRun(run: AgentRun): void {
    run.updatedAt = new Date().toISOString();
    this.writeRun(run);
  }

  appendEvent(run: AgentRun, event: Omit<RunEvent, "at">): void {
    run.events.push({ at: new Date().toISOString(), ...event });
    this.updateRun(run);
  }

  private writeRun(run: AgentRun): void {
    this.database.prepare(`
      INSERT INTO runs(id, status, objective, messages_json, events_json, step, result, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status, messages_json=excluded.messages_json, events_json=excluded.events_json,
        step=excluded.step, result=excluded.result, error=excluded.error, updated_at=excluded.updated_at
    `).run(
      run.id,
      run.status,
      run.objective,
      JSON.stringify(run.messages),
      JSON.stringify(run.events),
      run.step,
      run.result ?? null,
      run.error ?? null,
      run.createdAt,
      run.updatedAt,
    );
  }
}

function fromRow(row: RunRow): AgentRun {
  return {
    id: row.id,
    status: row.status,
    objective: row.objective,
    messages: JSON.parse(row.messages_json) as ChatMessage[],
    events: JSON.parse(row.events_json) as RunEvent[],
    step: row.step,
    ...(row.result === null ? {} : { result: row.result }),
    ...(row.error === null ? {} : { error: row.error }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
