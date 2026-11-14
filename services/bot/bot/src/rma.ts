// The bot's sessions in the shape of the Run My Agents board API, so the real board page (rma.generated.ts, copied from
// run-my-agents by scripts/sync-rma.ts) can draw them: one job or chat is one agent card with a face, a feed and a state.
import { TERMINAL, type Checkpoint, type Step } from './jobs';
import { FACES } from './rma.generated';

// Which Run My Agents face stands for what the bot is doing.
const ROLE: Record<string, string> = { 'readme-score': 'Chores', 'ai-findable': 'SEO', task: 'Code', chat: 'Calls' };
const DOING: Record<Step, string> = {
  claiming: 'Claiming the job',
  claimed: 'Doing the work',
  worked: 'Submitting the result',
  submitted: 'Waiting for the poster',
  accepted: 'Accepted by the poster',
  rejected: 'Rejected by the poster',
  failed: 'Gave the job back',
  lost: 'Lost the job',
};
const WORKING: Step[] = ['claiming', 'claimed', 'worked'];

export interface Row {
  sessionId: string;
  lastActivity: string;
  c: Checkpoint;
  active: boolean;
}

export function boardSession(r: Row, board: string) {
  const { c } = r;
  const j = c.job;
  const role = ROLE[j ? j.kind : 'chat'] ?? 'Code';
  const at = (s: string) => Date.parse(s) || Date.now();
  const feed = c.messages.map((m) => ({
    who: m.role === 'user' ? 'you' : 'agent',
    text: m.content,
    tools: m.event ? [m.event] : [],
    at: at(m.at),
    t0: at(m.at),
  }));
  const last = c.messages.at(-1);
  const sending = r.active || (!!j && WORKING.includes(j.step));
  return {
    id: r.sessionId,
    agent: 'claude',
    // A session that only used Flisk's own tools (README Score, Citable) used no model: same input, same answer.
    model: c.modelCalls ? 'Flisk Wolf' : 'no model',
    tokens: { used: 0, cached: 0 },
    cwd: j ? j.boardUrl : board,
    branch: j ? j.step : 'chat',
    branches: [],
    title: c.title || j?.title || (c.messages.find((m) => m.role === 'user')?.content.slice(0, 60) ?? 'New session'),
    said: last?.role === 'agent' ? last.content.slice(0, 200) : '',
    doing: j ? DOING[j.step] : sending ? 'Working' : '',
    edits: [],
    role,
    roleSet: true,
    pinned: false,
    awaiting: false,
    viaApp: false,
    face: FACES[role] ?? FACES.Code,
    lower: null,
    skills: [],
    sending,
    prs: j?.result
      ? [{ number: 0, title: j.result.summary, state: j.step === 'accepted' ? 'MERGED' : 'OPEN', url: j.result.url, repo: new URL(board).host, branch: j.step, draft: false, checks: TERMINAL.includes(j.step) && j.step !== 'accepted' ? 'failure' : 'success', review: j.step === 'accepted' ? 'APPROVED' : 'REVIEW_REQUIRED', merge: j.step === 'accepted' ? 'MERGED' : 'BLOCKED' }]
      : [],
    queue: [],
    updatedAt: at(r.lastActivity),
    feed,
  };
}

/** The answer to the board's GET api/sessions. */
export function boardSessions(rows: Row[], board: string) {
  return { sessions: rows.map((r) => boardSession(r, board)), clashes: [], limits: { sessionTokens: 0, autoDowngrade: false }, order: [], build: 'bot' };
}

/** The answer to the board's GET api/options, which its new-session form reads. */
export function boardOptions() {
  return {
    agents: { claude: true, codex: false, grok: false },
    defaultAgent: 'claude',
    folders: [],
    roles: Object.entries(FACES).map(([role, f]) => ({ role, color: f.color, shape: f.shape, eyes: f.eyes })),
  };
}

/**
 * Tune board page polling for bot.flisk.si (perf: issue #2):
 * 1. Skip periodic kLoad calls because tasks and lanes are always empty on the bot board.
 * 2. Poll api/sessions every 15s instead of 3s, pause polls while document.hidden, and refresh on visibilitychange.
 */
export function tuneBoardPage(page: string): string {
  return page
    .replace('setInterval(kLoad,3000);kLoad();', '/* kLoad disabled on bot board */')
    .replace(
      'load();setInterval(load,3000);',
      'load();setInterval(()=>{if(!document.hidden)load()},15000);document.addEventListener("visibilitychange",()=>{if(!document.hidden)load()});',
    );
}

// A slim Flisk header on top of the board page: where the bot is, and links to the jobs board and the source.
// Added when the page is served, so `scripts/sync-rma.ts` can overwrite rma.generated.ts without losing it.
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
export function withHeader(page: string, jobsUrl: string): string {
  const tuned = tuneBoardPage(page);
  const j = esc((jobsUrl || 'https://jobs.flisk.si').replace(/\/+$/, ''));
  const css =
    '<style>body{display:flex;flex-direction:column;padding:0!important}.app{flex:1;min-height:0;height:auto!important;margin:var(--p1)}flisk-bar,#flhead{flex:none}#flhead{height:38px;display:flex;align-items:center;gap:20px;padding:0 16px;background:#06060a;border-bottom:1px solid #1d1d28;font:500 12px/1 var(--body,system-ui,sans-serif)}' +
    '#flhead a{color:#9a9aab;text-decoration:none;letter-spacing:.06em;text-transform:uppercase;font-size:11px}#flhead a:hover{color:#fff}' +
    '#flhead .brand{color:#fff;font-weight:800;font-size:15px;letter-spacing:0;text-transform:none}#flhead .brand span{color:#2dd4bf}#flhead a[aria-current]{color:#fff;border-bottom:2px solid #2dd4bf;padding:4px 0}#flhead .sp{flex:1}#flhead a.post{background:#2dd4bf;color:#06060a;padding:7px 12px;font-weight:700}#flhead a.post:hover{background:#fff}' +
    // One line per link; on a phone the row scrolls inside itself instead of pushing the page sideways.
    '#flhead a{white-space:nowrap;flex:none}@media(max-width:640px){#flhead{gap:14px;overflow-x:auto;scrollbar-width:none}#flhead::-webkit-scrollbar{display:none}}</style>';
  const bar =
    '<header id="flhead"><a class="brand" href="/">flisk <span>bot</span></a><a href="/" aria-current="page">Chat</a>' +
    `<a href="${j}/">Jobs</a><a href="${j}/agents">Agents</a><a href="${j}/how">For agents</a><span class="sp"></span><a class="post" href="${j}/post">Post a job</a>` +
    '<a href="https://github.com/flisk-sh/flisk-bot">Source</a></header>';
  return tuned.replace('</head>', css + '<script src="https://flisk.si/assets/bar.js" defer></script></head>').replace('<body>', '<body>' + bar);
}
