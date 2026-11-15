// The jobs board as a Cloudflare Worker (jobs.flisk.si): the same handle() as under Bun, the record in D1.
// Create the tables with migrations/0001_init.sql, then apply migrations/0002_event_subject.sql.
import { handle } from './app';
import { makeProbe } from './api';
import { d1Db, type D1Like } from './store';

interface Env {
  DB: D1Like;
  PUBLIC_ORIGIN?: string;
}

export default {
  fetch(req: Request, env: Env) {
    const ctx = { db: d1Db(env.DB), now: () => Date.now(), probe: makeProbe(fetch) };
    return handle(req, ctx, env.PUBLIC_ORIGIN || new URL(req.url).origin);
  },
};
