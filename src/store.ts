import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentRun, ChatMessage, RunEvent, RunStatus } from "./types.js";

interface RunRow {
  id: string;
  user_id: string;
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
        user_id TEXT NOT NULL DEFAULT 'operator',
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL DEFAULT 'operator',
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
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider, external_id)
      );
      CREATE TABLE IF NOT EXISTS user_provider_secrets (
        user_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, provider_id)
      );
      CREATE TABLE IF NOT EXISTS user_consents (
        user_id TEXT NOT NULL,
        consent_id TEXT NOT NULL,
        version TEXT NOT NULL,
        agreed_at TEXT NOT NULL,
        PRIMARY KEY(user_id, consent_id)
      );
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL DEFAULT 'operator',
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
        user_id TEXT NOT NULL DEFAULT 'operator',
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        rating INTEGER NOT NULL CHECK(rating IN (-1, 1)),
        created_at TEXT NOT NULL
      );
    `);
    this.addColumnIfMissing("sessions", "user_id", "TEXT NOT NULL DEFAULT 'operator'");
    this.addColumnIfMissing("runs", "user_id", "TEXT NOT NULL DEFAULT 'operator'");
    this.addColumnIfMissing("usage_events", "user_id", "TEXT NOT NULL DEFAULT 'operator'");
    this.addColumnIfMissing("model_feedback", "user_id", "TEXT NOT NULL DEFAULT 'operator'");
  }

  createSession(tokenHash: string, expiresAt: number, userId = "operator"): void {
    this.database.prepare("INSERT INTO sessions(token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(tokenHash, userId, expiresAt, Date.now());
  }

  sessionUser(tokenHash: string, now = Date.now()): string | undefined {
    const row = this.database.prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?").get(tokenHash) as { user_id: string; expires_at: number } | undefined;
    return row !== undefined && row.expires_at > now ? row.user_id : undefined;
  }

  validSession(tokenHash: string, now = Date.now()): boolean {
    return this.sessionUser(tokenHash, now) !== undefined;
  }

  deleteSession(tokenHash: string): void {
    this.database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  deleteSessionsForUser(userId: string): void {
    this.database.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }

  pruneSessions(now = Date.now()): void {
    this.database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  }

  ping(): boolean {
    return (this.database.prepare("SELECT 1 AS ok").get() as { ok: number }).ok === 1;
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

  upsertUser(user: { id: string; provider: string; externalId: string; displayName: string }): void {
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO users(id, provider, external_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, updated_at=excluded.updated_at
    `).run(user.id, user.provider, user.externalId, user.displayName, now, now);
  }

  getUser(id: string): { id: string; provider: string; externalId: string; displayName: string } | undefined {
    const row = this.database.prepare("SELECT id, provider, external_id, display_name FROM users WHERE id = ?").get(id) as {
      id: string; provider: string; external_id: string; display_name: string;
    } | undefined;
    return row ? { id: row.id, provider: row.provider, externalId: row.external_id, displayName: row.display_name } : undefined;
  }

  recordConsent(userId: string, consentId: string, version: string): void {
    this.database.prepare(`
      INSERT INTO user_consents(user_id, consent_id, version, agreed_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, consent_id) DO UPDATE SET version=excluded.version, agreed_at=excluded.agreed_at
    `).run(userId, consentId, version, new Date().toISOString());
  }

  setUserProviderSecret(userId: string, providerId: string, ciphertext: string, iv: string, authTag: string): void {
    this.database.prepare(`
      INSERT INTO user_provider_secrets(user_id, provider_id, ciphertext, iv, auth_tag, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, provider_id) DO UPDATE SET ciphertext=excluded.ciphertext, iv=excluded.iv, auth_tag=excluded.auth_tag, updated_at=excluded.updated_at
    `).run(userId, providerId, ciphertext, iv, authTag, new Date().toISOString());
  }

  userProviderSecrets(userId: string): Array<{ providerId: string; ciphertext: string; iv: string; authTag: string }> {
    const rows = this.database.prepare("SELECT provider_id, ciphertext, iv, auth_tag FROM user_provider_secrets WHERE user_id = ?").all(userId) as unknown as Array<{
      provider_id: string; ciphertext: string; iv: string; auth_tag: string;
    }>;
    return rows.map((row) => ({ providerId: row.provider_id, ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag }));
  }

  deleteUserProviderSecret(userId: string, providerId: string): void {
    this.database.prepare("DELETE FROM user_provider_secrets WHERE user_id = ? AND provider_id = ?").run(userId, providerId);
  }

  deleteUserAccount(userId: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
      this.database.prepare("DELETE FROM user_provider_secrets WHERE user_id = ?").run(userId);
      this.database.prepare("DELETE FROM user_consents WHERE user_id = ?").run(userId);
      this.database.prepare("DELETE FROM model_feedback WHERE user_id = ?").run(userId);
      this.database.prepare("DELETE FROM usage_events WHERE user_id = ?").run(userId);
      this.database.prepare("DELETE FROM runs WHERE user_id = ?").run(userId);
      this.database.prepare("DELETE FROM response_cache WHERE cache_key LIKE ?").run(`${userId}:%`);
      this.database.prepare("DELETE FROM users WHERE id = ?").run(userId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  recordUsage(event: {
    providerId: string; modelId: string; endpoint: string; promptTokens?: number; completionTokens?: number;
    totalTokens?: number; status: number; latencyMs: number; userId?: string;
  }): void {
    this.database.prepare(`
      INSERT INTO usage_events(user_id, provider_id, model_id, endpoint, prompt_tokens, completion_tokens, total_tokens, status, latency_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.userId ?? "operator", event.providerId, event.modelId, event.endpoint, event.promptTokens ?? 0, event.completionTokens ?? 0,
      event.totalTokens ?? 0, event.status, event.latencyMs, new Date().toISOString(),
    );
  }

  usageSummary(since: string, userId?: string): Array<Record<string, unknown>> {
    const where = userId ? "created_at >= ? AND user_id = ?" : "created_at >= ?";
    return this.database.prepare(`
      SELECT provider_id, model_id, COUNT(*) AS requests, SUM(prompt_tokens) AS prompt_tokens,
        SUM(completion_tokens) AS completion_tokens, SUM(total_tokens) AS total_tokens,
        ROUND(AVG(latency_ms), 1) AS average_latency_ms,
        SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS successful_requests
      FROM usage_events WHERE ${where} GROUP BY provider_id, model_id ORDER BY total_tokens DESC, requests DESC
    `).all(...(userId ? [since, userId] : [since])) as unknown as Array<Record<string, unknown>>;
  }

  tokensUsedSince(userId: string, since: string): number {
    const row = this.database.prepare("SELECT COALESCE(SUM(total_tokens), 0) AS total FROM usage_events WHERE user_id = ? AND created_at >= ?").get(userId, since) as { total: number };
    return row.total;
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

  recordFeedback(runId: string, providerId: string, modelId: string, rating: -1 | 1, userId = "operator"): void {
    this.database.prepare(`
      INSERT INTO model_feedback(run_id, user_id, provider_id, model_id, rating, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET user_id=excluded.user_id, provider_id=excluded.provider_id, model_id=excluded.model_id, rating=excluded.rating, created_at=excluded.created_at
    `).run(runId, userId, providerId, modelId, rating, new Date().toISOString());
  }

  providerFeedbackAdjustments(userId = "operator"): Record<string, number> {
    const rows = this.database.prepare(`
      SELECT provider_id, AVG(rating) AS average_rating, COUNT(*) AS ratings FROM model_feedback WHERE user_id = ? GROUP BY provider_id
    `).all(userId) as unknown as Array<{ provider_id: string; average_rating: number; ratings: number }>;
    return Object.fromEntries(rows.map((row) => [row.provider_id, Math.max(-10, Math.min(10, row.average_rating * Math.min(10, row.ratings))) ]));
  }

  createRun(objective: string, userId = "operator"): AgentRun {
    const now = new Date().toISOString();
    const run: AgentRun = {
      id: crypto.randomUUID(),
      userId,
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

  getRun(id: string, userId?: string): AgentRun | undefined {
    const row = (userId
      ? this.database.prepare("SELECT * FROM runs WHERE id = ? AND user_id = ?").get(id, userId)
      : this.database.prepare("SELECT * FROM runs WHERE id = ?").get(id)) as unknown as RunRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  resumableRuns(userId?: string): AgentRun[] {
    const rows = (userId
      ? this.database.prepare("SELECT * FROM runs WHERE user_id = ? AND status IN ('queued', 'running') ORDER BY created_at").all(userId)
      : this.database.prepare("SELECT * FROM runs WHERE status IN ('queued', 'running') ORDER BY created_at").all()) as unknown as RunRow[];
    return rows.map(fromRow);
  }

  listRuns(limit = 50, userId?: string): AgentRun[] {
    const bounded = Math.max(1, Math.min(200, limit));
    const rows = (userId
      ? this.database.prepare("SELECT * FROM runs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").all(userId, bounded)
      : this.database.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?").all(bounded)) as unknown as RunRow[];
    return rows.map(fromRow);
  }

  activeRunCount(userId: string): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM runs WHERE user_id = ? AND status IN ('queued', 'running')").get(userId) as { count: number };
    return row.count;
  }

  totalActiveRunCount(): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM runs WHERE status IN ('queued', 'running')").get() as { count: number };
    return row.count;
  }

  pruneHistoricalData(beforeIso: string, now = Date.now()): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM runs WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at < ?").run(beforeIso);
      this.database.prepare("DELETE FROM usage_events WHERE created_at < ?").run(beforeIso);
      this.database.prepare("DELETE FROM model_feedback WHERE run_id NOT IN (SELECT id FROM runs)").run();
      this.database.prepare("DELETE FROM response_cache WHERE expires_at <= ?").run(now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
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
      INSERT INTO runs(id, user_id, status, objective, messages_json, events_json, step, result, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status, messages_json=excluded.messages_json, events_json=excluded.events_json,
        step=excluded.step, result=excluded.result, error=excluded.error, updated_at=excluded.updated_at
    `).run(
      run.id,
      run.userId,
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

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function fromRow(row: RunRow): AgentRun {
  return {
    id: row.id,
    userId: row.user_id,
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
