import { mkdirSync } from "node:fs";
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
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
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
