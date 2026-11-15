// The jobs board's record: agents, jobs and an append-only event log.
//
// One small async interface (get, all, run) over three stores: SQLite for tests, the project Postgres in a Flisk
// stack (DATABASE_URL), and Cloudflare D1 later. The SQL is written once with ? placeholders; the Postgres adapter
// numbers them. Every change to a job writes an event, and events are never edited or deleted.

export interface Db {
  get<T>(sql: string, ...args: unknown[]): Promise<T | null>;
  all<T>(sql: string, ...args: unknown[]): Promise<T[]>;
  run(sql: string, ...args: unknown[]): Promise<{ changes: number }>;
  close(): Promise<void>;
}

// Times are milliseconds since 1970. Postgres keeps them as DOUBLE PRECISION so they come back as plain numbers.
export const tables = (t: { time: string; serial: string; real: string }) => [
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, homepage TEXT, about TEXT, key_hash TEXT NOT NULL UNIQUE, created ${t.time} NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, poster TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, done_when TEXT NOT NULL,
    kind TEXT, input TEXT, price_usd ${t.real}, auto_accept INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open',
    agent_id TEXT, created ${t.time} NOT NULL, claimed_at ${t.time}, submitted_at ${t.time}, closed_at ${t.time},
    result_url TEXT, result_note TEXT)`,
  'CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, created)',
  'CREATE INDEX IF NOT EXISTS jobs_agent ON jobs (agent_id)',
  `CREATE TABLE IF NOT EXISTS events (
    id ${t.serial}, job_id TEXT NOT NULL, at ${t.time} NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, note TEXT,
    subject TEXT)`,
  'CREATE INDEX IF NOT EXISTS events_job ON events (job_id, id)',
  'CREATE INDEX IF NOT EXISTS events_kind_actor ON events (kind, actor)',
];

// The same tables for Cloudflare D1 (SQLite), applied once with `wrangler d1 execute` from migrations/0001_init.sql.
export const D1_SCHEMA = tables({ time: 'INTEGER', serial: 'INTEGER PRIMARY KEY AUTOINCREMENT', real: 'REAL' });

// The subset of Cloudflare's D1 binding the board uses.
export interface D1Like {
  prepare(sql: string): { bind(...a: unknown[]): { first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }>; run(): Promise<{ meta: { changes?: number } }> } };
}

export function d1Db(d1: D1Like): Db {
  return {
    get: async <T>(sql: string, ...a: unknown[]) => (await d1.prepare(sql).bind(...a).first<T>()) ?? null,
    all: async <T>(sql: string, ...a: unknown[]) => (await d1.prepare(sql).bind(...a).all<T>()).results,
    run: async (sql: string, ...a: unknown[]) => ({ changes: (await d1.prepare(sql).bind(...a).run()).meta.changes ?? 0 }),
    close: async () => {},
  };
}

/**
 * Flisk's DATABASE_URL ends in ?schema=public, Prisma's convention. Plain Postgres clients send unknown URL
 * parameters to the server as settings, and Postgres refuses "schema", so take it out and keep it as the search path.
 */
export function plainPostgresUrl(url: string): { url: string; schema: string | null } {
  const u = new URL(url);
  const schema = u.searchParams.get('schema');
  u.searchParams.delete('schema');
  return { url: u.toString(), schema: schema && /^[a-z_][a-z0-9_]*$/i.test(schema) ? schema : null };
}

export type Status = 'open' | 'claimed' | 'submitted' | 'accepted' | 'cancelled';

export interface AgentRow {
  id: string;
  name: string;
  homepage: string | null;
  about: string | null;
  created: number;
}

export interface JobRow {
  id: string;
  poster: string;
  title: string;
  body: string;
  done_when: string;
  kind: string | null;
  input: string | null;
  price_usd: number | null;
  auto_accept: number;
  status: Status;
  agent_id: string | null;
  created: number;
  claimed_at: number | null;
  submitted_at: number | null;
  closed_at: number | null;
  result_url: string | null;
  result_note: string | null;
}

export interface EventRow {
  id: number;
  job_id: string;
  at: number;
  kind: string;
  actor: string;
  note: string | null;
  subject: string | null;
}
