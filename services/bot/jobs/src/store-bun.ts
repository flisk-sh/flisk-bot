// Bun-only adapters for the jobs board: SQLite (tests, plain processes) and the Flisk stack's Postgres.
// Kept apart from store.ts so the Cloudflare Worker bundle never imports bun or bun:sqlite.
import { Database } from 'bun:sqlite';
import { type Db, plainPostgresUrl, tables } from './store';

export async function sqliteDb(path: string): Promise<Db> {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  for (const s of tables({ time: 'INTEGER', serial: 'INTEGER PRIMARY KEY AUTOINCREMENT', real: 'REAL' })) db.exec(s);
  try { db.exec('ALTER TABLE events ADD COLUMN subject TEXT'); } catch (e) {
    if (!String(e).toLowerCase().includes('duplicate column')) throw e;
  }
  db.exec("UPDATE events SET subject = substr(note, 1, instr(note, CASE WHEN kind = 'rejected' THEN ':' ELSE ' ' END) - 1) WHERE subject IS NULL AND kind IN ('rejected', 'claim_expired') AND instr(note, CASE WHEN kind = 'rejected' THEN ':' ELSE ' ' END) > 1");
  db.exec('CREATE INDEX IF NOT EXISTS events_subject ON events (subject, kind)');
  return {
    get: async <T>(sql: string, ...a: unknown[]) => (db.query(sql).get(...(a as never[])) as T) ?? null,
    all: async <T>(sql: string, ...a: unknown[]) => db.query(sql).all(...(a as never[])) as T[],
    run: async (sql: string, ...a: unknown[]) => ({ changes: db.query(sql).run(...(a as never[])).changes }),
    close: async () => db.close(),
  };
}

export async function postgresDb(raw: string): Promise<Db> {
  const { SQL } = await import('bun');
  const { url, schema } = plainPostgresUrl(raw);
  const pg = new SQL(url);
  if (schema) await pg.unsafe(`SET search_path TO "${schema}"`);
  const numbered = (sql: string) => {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  };
  for (const s of tables({ time: 'DOUBLE PRECISION', serial: 'SERIAL PRIMARY KEY', real: 'DOUBLE PRECISION' })) await pg.unsafe(s);
  await pg.unsafe('ALTER TABLE events ADD COLUMN IF NOT EXISTS subject TEXT');
  await pg.unsafe("UPDATE events SET subject = split_part(note, CASE WHEN kind = 'rejected' THEN ':' ELSE ' ' END, 1) WHERE subject IS NULL AND kind IN ('rejected', 'claim_expired') AND strpos(note, CASE WHEN kind = 'rejected' THEN ':' ELSE ' ' END) > 1");
  await pg.unsafe('CREATE INDEX IF NOT EXISTS events_subject ON events (subject, kind)');
  return {
    get: async <T>(sql: string, ...a: unknown[]) => ((await pg.unsafe(numbered(sql), a as never[]))[0] as T) ?? null,
    all: async <T>(sql: string, ...a: unknown[]) => [...(await pg.unsafe(numbered(sql), a as never[]))] as T[],
    run: async (sql: string, ...a: unknown[]) => ({ changes: Number((await pg.unsafe(numbered(sql), a as never[])).count ?? 0) }),
    close: async () => pg.close(),
  };
}
