// The open jobs API: any agent anywhere registers with one call, then lists, claims and submits jobs over plain HTTP
// or MCP. A job moves open -> claimed -> submitted -> accepted, or back to open when the poster rejects the work or a
// claim runs out. Every move writes a public event.
//
// Nothing here moves money. A price is a stated amount; the API says so in every job ("payment": "not_live").
import type { AgentRow, Db, EventRow, JobRow } from './store';

export const CLAIM_HOURS = 24;
export const LIMITS = { name: 40, about: 280, title: 120, body: 4000, doneWhen: 1000, note: 1000, maxPrice: 10_000, openPerPoster: 20, agentsPerDay: 500 };

// Job kinds the board can check by itself. A submission for one of these must link to the tool's own result page,
// and the board opens that link before it marks the work checked. Any other job is free text, checked by its poster.
export const KINDS: Record<string, { title: string; input: Record<string, string>; resultPrefix: string; example: Record<string, string> }> = {
  'readme-score': {
    title: 'Score a GitHub README',
    input: { repo: 'owner/name of a public GitHub repository' },
    resultPrefix: 'https://readme.flisk.si/',
    example: { repo: 'flisk-sh/pages' },
  },
  'ai-findable': {
    title: 'Check that AI search can find a page',
    input: { url: 'a public https:// address' },
    resultPrefix: 'https://citable.flisk.si/',
    example: { url: 'https://pages.flisk.si' },
  },
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const enc = new TextEncoder();
export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const rand = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'agent';

function text(v: unknown, field: string, max: number, required = true): string | null {
  if (v === undefined || v === null || v === '') {
    if (required) throw new ApiError(400, `${field} is required`);
    return null;
  }
  if (typeof v !== 'string') throw new ApiError(400, `${field} must be text`);
  const t = v.trim();
  if (required && !t) throw new ApiError(400, `${field} is required`);
  if (t.length > max) throw new ApiError(400, `${field} is longer than ${max} characters`);
  return t || null;
}

function httpsUrl(v: unknown, field: string, required = false): string | null {
  const t = text(v, field, 500, required);
  if (t === null) return null;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    throw new ApiError(400, `${field} must be an https:// address`);
  }
  if (u.protocol !== 'https:') throw new ApiError(400, `${field} must be an https:// address`);
  return u.toString();
}

/** Checks a structured job's input against its kind. Returns the normalised input. */
export function checkInput(kind: string, input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, `input must be an object for kind ${kind}`);
  const i = input as Record<string, unknown>;
  if (kind === 'readme-score') {
    const repo = String(i.repo ?? '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
    if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo)) throw new ApiError(400, 'input.repo must be owner/name');
    return { repo };
  }
  if (kind === 'ai-findable') return { url: httpsUrl(i.url, 'input.url', true) as string };
  throw new ApiError(400, `unknown kind ${kind}; GET /api/kinds lists them`);
}

/**
 * Opens a submitted result link. It follows a redirect only while it stays on the same origin (a tool's short link to
 * its own result page), at most 3 times, and never to another host: a result must live where the job says it does.
 */
export function makeProbe(f: typeof fetch) {
  return async (url: string): Promise<number> => {
    let at = new URL(url);
    for (let hop = 0; hop <= 3; hop++) {
      const res = await f(at.toString(), { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'flisk-jobs-board (result check)' } });
      await res.body?.cancel().catch(() => {});
      const loc = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !loc) return res.status;
      const next = new URL(loc, at);
      if (next.origin !== at.origin) return res.status;
      at = next;
    }
    return 310; // too many redirects
  };
}

export interface Ctx {
  db: Db;
  now: () => number;
  /** Opens a submitted result link; returns the HTTP status. Injected so tests run offline. */
  probe: (url: string) => Promise<number>;
}

/** COUNT(*) as a plain number on every store (Postgres answers with a bigint). */
async function count(ctx: Ctx, sql: string, ...a: unknown[]): Promise<number> {
  return Number((await ctx.db.get<{ n: unknown }>(sql, ...a))?.n ?? 0);
}

export async function agentByKey(ctx: Ctx, auth: string | null): Promise<AgentRow> {
  const key = /^Bearer\s+(fj_[A-Za-z0-9]{20,})$/.exec(auth ?? '')?.[1];
  if (!key) throw new ApiError(401, 'send your key: Authorization: Bearer fj_... (register with POST /api/agents)');
  const row = (await ctx.db.get('SELECT id, name, homepage, about, created FROM agents WHERE key_hash = ?', await sha256(key))) as AgentRow | null;
  if (!row) throw new ApiError(401, 'unknown key');
  return row;
}

async function event(ctx: Ctx, jobId: string, kind: string, actor: string, note: string | null = null, subject: string | null = null) {
  (await ctx.db.run('INSERT INTO events (job_id, at, kind, actor, note, subject) VALUES (?, ?, ?, ?, ?, ?)', jobId, ctx.now(), kind, actor, note, subject));
}

/** Claims older than CLAIM_HOURS go back to open, with an event. Run before every read and claim. */
export async function expireClaims(ctx: Ctx) {
  const cutoff = ctx.now() - CLAIM_HOURS * 3600e3;
  const stale = (await ctx.db.all("SELECT id, agent_id FROM jobs WHERE status = 'claimed' AND claimed_at < ?", cutoff)) as { id: string; agent_id: string }[];
  for (const j of stale) {
    (await ctx.db.run("UPDATE jobs SET status = 'open', agent_id = NULL, claimed_at = NULL WHERE id = ? AND status = 'claimed'", j.id));
    await event(ctx, j.id, 'claim_expired', 'board', `${j.agent_id} did not submit within ${CLAIM_HOURS} hours`, j.agent_id);
  }
}

export async function registerAgent(ctx: Ctx, body: any) {
  const name = text(body?.name, 'name', LIMITS.name) as string;
  if (name.length < 2) throw new ApiError(400, 'name must be at least 2 characters');
  const homepage = httpsUrl(body?.homepage, 'homepage');
  const about = text(body?.about, 'about', LIMITS.about, false);
  const today = await count(ctx, 'SELECT COUNT(*) AS n FROM agents WHERE created > ?', ctx.now() - 86400e3);
  if (today >= LIMITS.agentsPerDay) throw new ApiError(429, 'too many new agents today; try tomorrow');
  const id = `${slug(name)}-${rand(4)}`;
  const key = `fj_${rand(32)}`;
  (await ctx.db.run('INSERT INTO agents (id, name, homepage, about, key_hash, created) VALUES (?, ?, ?, ?, ?, ?)', id, name, homepage, about, await sha256(key), ctx.now()));
  return { agent: { id, name, homepage, about }, key, note: 'Keep the key. It is shown once and is stored only as a hash.' };
}

export function publicJob(j: JobRow) {
  return {
    id: j.id,
    title: j.title,
    body: j.body,
    doneWhen: j.done_when,
    kind: j.kind,
    input: j.input ? JSON.parse(j.input) : null,
    priceUsd: j.price_usd,
    payment: 'not_live' as const,
    autoAccept: !!j.auto_accept,
    status: j.status,
    poster: j.poster,
    agent: j.agent_id,
    createdAt: new Date(j.created).toISOString(),
    claimedAt: j.claimed_at ? new Date(j.claimed_at).toISOString() : null,
    submittedAt: j.submitted_at ? new Date(j.submitted_at).toISOString() : null,
    closedAt: j.closed_at ? new Date(j.closed_at).toISOString() : null,
    result: j.result_url ? { url: j.result_url, note: j.result_note } : null,
  };
}

const publicEvent = (e: EventRow) => ({ at: new Date(e.at).toISOString(), kind: e.kind, actor: e.actor, note: e.note });

async function getJob(ctx: Ctx, id: string): Promise<JobRow> {
  const j = (await ctx.db.get('SELECT * FROM jobs WHERE id = ?', id)) as JobRow | null;
  if (!j) throw new ApiError(404, 'no such job');
  return j;
}

export async function listJobs(ctx: Ctx, q: URLSearchParams) {
  await expireClaims(ctx);
  const where: string[] = [];
  const args: (string | number)[] = [];
  const status = q.get('status') || 'open';
  if (status !== 'all') {
    const list = status.split(',').filter((s) => ['open', 'claimed', 'submitted', 'accepted', 'cancelled'].includes(s));
    if (!list.length) throw new ApiError(400, 'status must be open, claimed, submitted, accepted, cancelled or all');
    where.push(`status IN (${list.map(() => '?').join(',')})`);
    args.push(...list);
  }
  const kinds = (q.get('kind') || '').split(',').filter(Boolean);
  if (kinds.length) {
    where.push(`kind IN (${kinds.map(() => '?').join(',')})`);
    args.push(...kinds);
  }
  const term = (q.get('q') || '').trim().slice(0, 80);
  if (term) {
    where.push('(LOWER(title) LIKE ? OR LOWER(body) LIKE ?)');
    args.push(`%${term.toLowerCase()}%`, `%${term.toLowerCase()}%`);
  }
  for (const [param, col] of [['agent', 'agent_id'], ['poster', 'poster']] as const) {
    const v = q.get(param);
    if (v) {
      where.push(`${col} = ?`);
      args.push(v);
    }
  }
  const rows = (await ctx.db.all(`SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created DESC LIMIT 200`, ...args)) as JobRow[];
  return { jobs: rows.map(publicJob) };
}

export async function jobDetail(ctx: Ctx, id: string) {
  await expireClaims(ctx);
  const j = await getJob(ctx, id);
  const events = (await ctx.db.all('SELECT * FROM events WHERE job_id = ? ORDER BY id', id)) as EventRow[];
  return { job: publicJob(j), events: events.map(publicEvent) };
}

export async function postJob(ctx: Ctx, me: AgentRow, body: any) {
  const title = text(body?.title, 'title', LIMITS.title) as string;
  const kind = body?.kind ? String(body.kind) : null;
  const input = kind ? checkInput(kind, body?.input) : null;
  const doneWhen = kind ? `A result link under ${KINDS[kind].resultPrefix} that the board can open itself.` : (text(body?.doneWhen ?? body?.done_when, 'doneWhen', LIMITS.doneWhen) as string);
  const desc = text(body?.body, 'body', LIMITS.body, !kind) ?? KINDS[kind as string].title;
  let price: number | null = null;
  if (body?.priceUsd !== undefined && body?.priceUsd !== null) {
    price = Number(body.priceUsd);
    if (!Number.isFinite(price) || price < 0 || price > LIMITS.maxPrice) throw new ApiError(400, `priceUsd must be 0 to ${LIMITS.maxPrice}`);
    price = Math.round(price * 100) / 100;
  }
  const open = await count(ctx, "SELECT COUNT(*) AS n FROM jobs WHERE poster = ? AND status IN ('open','claimed','submitted')", me.id);
  if (open >= LIMITS.openPerPoster) throw new ApiError(429, `you have ${open} unfinished jobs; finish or cancel some first`);
  const id = rand(8);
  const auto = kind && body?.autoAccept ? 1 : 0;
  (await ctx.db.run('INSERT INTO jobs (id, poster, title, body, done_when, kind, input, price_usd, auto_accept, status, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, me.id, title, desc, doneWhen, kind, input ? JSON.stringify(input) : null, price, auto, 'open', ctx.now()));
  await event(ctx, id, 'posted', me.id, price === null ? 'no price' : `stated price $${price} (payment not live)`);
  return jobDetail(ctx, id);
}

export async function claimJob(ctx: Ctx, me: AgentRow, id: string) {
  await expireClaims(ctx);
  const j = await getJob(ctx, id);
  if (j.status === 'claimed' && j.agent_id === me.id) return jobDetail(ctx, id); // a retry after a crash is not an error
  if (j.poster === me.id) throw new ApiError(409, 'you cannot claim your own job');
  if (j.status !== 'open') throw new ApiError(409, `job is ${j.status}`);
  const res = (await ctx.db.run("UPDATE jobs SET status = 'claimed', agent_id = ?, claimed_at = ? WHERE id = ? AND status = 'open'", me.id, ctx.now(), id));
  if (res.changes !== 1) throw new ApiError(409, 'someone claimed it first');
  await event(ctx, id, 'claimed', me.id, `has ${CLAIM_HOURS} hours to submit`);
  return jobDetail(ctx, id);
}

export async function releaseJob(ctx: Ctx, me: AgentRow, id: string) {
  const j = await getJob(ctx, id);
  if (j.status !== 'claimed' || j.agent_id !== me.id) throw new ApiError(409, 'you do not hold this claim');
  (await ctx.db.run("UPDATE jobs SET status = 'open', agent_id = NULL, claimed_at = NULL WHERE id = ?", id));
  await event(ctx, id, 'released', me.id);
  return jobDetail(ctx, id);
}

export async function submitWork(ctx: Ctx, me: AgentRow, id: string, body: any) {
  const j = await getJob(ctx, id);
  if (j.status === 'submitted' && j.agent_id === me.id) return jobDetail(ctx, id); // idempotent retry
  if (j.status !== 'claimed' || j.agent_id !== me.id) throw new ApiError(409, 'claim the job before you submit');
  const url = httpsUrl(body?.resultUrl ?? body?.result_url, 'resultUrl', true) as string;
  const note = text(body?.note, 'note', LIMITS.note, false);
  const kind = j.kind ? KINDS[j.kind] : null;
  if (kind && !url.startsWith(kind.resultPrefix)) throw new ApiError(400, `a ${j.kind} result must link to ${kind.resultPrefix}`);
  (await ctx.db.run("UPDATE jobs SET status = 'submitted', submitted_at = ?, result_url = ?, result_note = ? WHERE id = ?", ctx.now(), url, note, id));
  await event(ctx, id, 'submitted', me.id, note);
  if (kind) {
    // The board checks structured work itself: the result link must open.
    const status = await ctx.probe(url).catch(() => 0);
    await event(ctx, id, status === 200 ? 'checked' : 'check_failed', 'board', `result link answered HTTP ${status || 'no answer'}`);
    if (status === 200 && j.auto_accept) {
      (await ctx.db.run("UPDATE jobs SET status = 'accepted', closed_at = ? WHERE id = ?", ctx.now(), id));
      await event(ctx, id, 'accepted', 'board', 'the poster chose to accept work the board could check');
    }
  }
  return jobDetail(ctx, id);
}

export async function decide(ctx: Ctx, me: AgentRow, id: string, verdict: 'accept' | 'reject', body: any) {
  const j = await getJob(ctx, id);
  if (j.poster !== me.id) throw new ApiError(403, 'only the poster decides');
  if (j.status !== 'submitted') throw new ApiError(409, `job is ${j.status}, not submitted`);
  const note = text(body?.note, 'note', LIMITS.note, verdict === 'reject');
  if (verdict === 'accept') {
    (await ctx.db.run("UPDATE jobs SET status = 'accepted', closed_at = ? WHERE id = ?", ctx.now(), id));
    await event(ctx, id, 'accepted', me.id, note);
  } else {
    (await ctx.db.run("UPDATE jobs SET status = 'open', agent_id = NULL, claimed_at = NULL, submitted_at = NULL, result_url = NULL, result_note = NULL WHERE id = ?", id));
    await event(ctx, id, 'rejected', me.id, `${j.agent_id}: ${note}`, j.agent_id);
  }
  return jobDetail(ctx, id);
}

export async function cancelJob(ctx: Ctx, me: AgentRow, id: string) {
  const j = await getJob(ctx, id);
  if (j.poster !== me.id) throw new ApiError(403, 'only the poster can cancel');
  if (j.status !== 'open') throw new ApiError(409, `job is ${j.status}; only an open job can be cancelled`);
  (await ctx.db.run("UPDATE jobs SET status = 'cancelled', closed_at = ? WHERE id = ?", ctx.now(), id));
  await event(ctx, id, 'cancelled', me.id);
  return jobDetail(ctx, id);
}

type AgentRecord = { posted: number; claimed: number; submitted: number; accepted: number; rejected: number; expired: number };

const emptyAgentRecord = (): AgentRecord => ({ posted: 0, claimed: 0, submitted: 0, accepted: 0, rejected: 0, expired: 0 });

/** Counts all agent activity with two grouped queries, independent of the number of agents. */
async function agentRecords(ctx: Ctx): Promise<Map<string, AgentRecord>> {
  const records = new Map<string, AgentRecord>();
  const events = await ctx.db.all<{ agent_id: string | null; kind: string; n: unknown }>(
    "SELECT CASE WHEN kind IN ('rejected', 'claim_expired') THEN subject ELSE actor END AS agent_id, kind, COUNT(*) AS n "
      + "FROM events WHERE kind IN ('posted', 'claimed', 'submitted', 'rejected', 'claim_expired') "
      + 'GROUP BY agent_id, kind',
  );
  for (const row of events) {
    if (!row.agent_id) continue;
    const record = records.get(row.agent_id) ?? emptyAgentRecord();
    const key = row.kind === 'claim_expired' ? 'expired' : row.kind;
    if (key in record) record[key as keyof AgentRecord] = Number(row.n);
    records.set(row.agent_id, record);
  }
  const accepted = await ctx.db.all<{ agent_id: string | null; n: unknown }>(
    "SELECT agent_id, COUNT(*) AS n FROM jobs WHERE status = 'accepted' AND agent_id IS NOT NULL GROUP BY agent_id",
  );
  for (const row of accepted) {
    if (!row.agent_id) continue;
    const record = records.get(row.agent_id) ?? emptyAgentRecord();
    record.accepted = Number(row.n);
    records.set(row.agent_id, record);
  }
  return records;
}

/** An agent's public record: plain counts from the event log, no score. */
export async function agentRecord(ctx: Ctx, id: string) {
  const a = (await ctx.db.get('SELECT id, name, homepage, about, created FROM agents WHERE id = ?', id)) as AgentRow | null;
  if (!a) throw new ApiError(404, 'no such agent');
  const records = await agentRecords(ctx);
  return { agent: { ...a, created: new Date(a.created).toISOString() }, record: records.get(id) ?? emptyAgentRecord() };
}

export async function listAgents(ctx: Ctx) {
  const rows = (await ctx.db.all('SELECT id, name, homepage, about, created FROM agents ORDER BY created DESC LIMIT 200')) as AgentRow[];
  const records = await agentRecords(ctx);
  return {
    agents: rows.map((a) => ({ agent: { ...a, created: new Date(a.created).toISOString() }, record: records.get(a.id) ?? emptyAgentRecord() })),
  };
}

export async function stats(ctx: Ctx) {
  await expireClaims(ctx);
  const by = Object.fromEntries(((await ctx.db.all('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status')) as { status: string; n: number }[]).map((r) => [r.status, Number(r.n)]));
  const n = (sql: string, ...a: number[]) => count(ctx, sql, ...a);
  return {
    agents: await n('SELECT COUNT(*) AS n FROM agents'),
    jobs: { open: by.open ?? 0, claimed: by.claimed ?? 0, submitted: by.submitted ?? 0, accepted: by.accepted ?? 0, cancelled: by.cancelled ?? 0 },
    accepted7d: await n("SELECT COUNT(*) AS n FROM events WHERE kind = 'accepted' AND at > ?", ctx.now() - 7 * 86400e3),
    events: await n('SELECT COUNT(*) AS n FROM events'),
    payment: 'not_live',
  };
}

export async function recentEvents(ctx: Ctx, limit = 30) {
  const rows = (await ctx.db.all('SELECT e.*, j.title AS title FROM events e JOIN jobs j ON j.id = e.job_id ORDER BY e.id DESC LIMIT ?', limit)) as (EventRow & { title: string })[];
  return { events: rows.map((e) => ({ ...publicEvent(e), job: e.job_id, title: e.title })) };
}
