// The write side. AIs never touch the vault: each write goes into a queue (the `writes` table), and the applier
// on the vault machine claims writes in order, saves them into the vault and reports back. If that machine is
// offline, writes wait and the AI is told plainly that writing is paused while reading still works.
import { localNow } from './config.js';
import { ToolError } from './tools.js';
import { BadNotes, upsertNotes } from './sync.js';

export const CATEGORIES = ['coding', 'study', 'research', 'writing', 'planning', 'meeting', 'call', 'interview', 'lecture', 'other'];
const MAX_QUEUE = 500;      // waiting writes before new ones are refused
const MAX_ATTEMPTS = 5;     // applier tries per write
const LEASE_MS = 2 * 60e3;  // how long a claimed write is reserved for the applier

const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '');
const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const list = (description) => ({ type: 'array', items: { type: 'string' }, description });
const tool = (name, description, properties, required = []) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const WRITE_TOOLS = [
  tool('log_session', 'Save this work or study session to their notes as a session note (summary, what changed or was covered, decisions, open questions, next steps), linked from their daily note and project. Call it at the first real milestone, then again with the returned session_id at later milestones, always sending the full cumulative content. Not for quick questions. Writes are saved by their vault machine: say it is saved only when saved is true; if writing is paused, say it is queued.', {
    title: S('Short outcome title, 2–6 words'),
    kind: S('work or study', { enum: ['work', 'study'] }),
    category: S('What kind of session', { enum: CATEGORIES }),
    project: S('Exact title of an existing project, course or area note (find it with search_notes); leave empty if none fits'),
    summary: S('Cumulative 2–4 sentence summary of the whole session so far'),
    changes: list('Work: what changed. Study: what was covered.'),
    decisions: list('Work: decisions made. Study: key ideas.'),
    still_unclear: list('Study: questions still unclear'),
    next_steps: list('Work: open tasks. Study: what to review next.'),
    links: list('Useful references: repos, branches, files, URLs, notes. No secrets.'),
    source: S('Which AI or app you are, e.g. claude, chatgpt, codex'),
    session_id: S('Leave out the first time. To update the same session note, send the session_id you got back.'),
  }, ['title', 'summary']),
  tool('create_note', 'Create a NEW note in an existing folder, only when they ask for one. Search first so you do not duplicate a note. It cannot edit, replace or delete notes. Never include secrets. Say it is saved only when saved is true.', {
    title: S('Note title, without .md or filename punctuation, up to 120 characters'),
    folder: S('An existing folder, exactly as it appears in note paths from search_notes or list_notes'),
    content: S('Markdown body, up to 20000 characters, without frontmatter or the top-level title. Include useful [[links]].'),
    source: S('Which AI or app you are'),
  }, ['title', 'folder', 'content']),
  tool('write_status', 'Check whether a write from log_session or create_note was saved, and whether writing is currently paused. Check on a later turn rather than polling.', {
    write_id: S('write_id from log_session or create_note'),
    session_id: S('Or a session_id, for its latest update'),
  }),
];

// Shapes of passwords, keys and tokens. A write that contains one is refused: secrets never go into notes.
const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/, /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bgithub_pat_[A-Za-z0-9_]{30,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/, /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|token)\s*[:=]\s*["']?(?=[^\s"']*\d)[^\s"']{16,}/i,
];
const noSecrets = (...parts) => {
  const text = JSON.stringify(parts);
  if (SECRETS.some((re) => re.test(text))) throw new ToolError('This looks like it contains a password, key or token. Remove it and try again: Talisman never saves secrets.');
};
// For captured chats, where refusing isn't an option: blank out anything shaped like a secret.
const SECRETS_ALL = SECRETS.map((re) => new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
export const redactSecrets = (text) => SECRETS_ALL.reduce((t, re) => t.replace(re, '[REDACTED]'), text);

const BAD_NAME = /[\x00-\x1f\x7f\\/:#^|\[\]?*"<>]/;
const SYSTEM_FOLDER = /^(templates|attachments|transcripts|daily notes|daily)$/i;
const items = (v, name) => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 30) throw new ToolError(`${name} must be a list of up to 30 items.`);
  return v.map((x) => clip(String(x ?? ''), 600)).filter(Boolean);
};
const text = (v, name, max) => {
  const t = clip(v, max + 1);
  if (!t) throw new ToolError(`${name} is required.`);
  if (t.length > max) throw new ToolError(`${name} must be at most ${max} characters.`);
  return t;
};

export async function writerStatus(env) {
  const seen = await env.DB.prepare("SELECT value FROM meta WHERE key = 'applier_seen'").first('value');
  const staleMs = (Number(env.APPLIER_STALE_SECONDS) || 90) * 1000;
  const waiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM writes WHERE status IN ('queued', 'applying')").first('n');
  return { online: Boolean(seen) && Date.now() - Date.parse(seen) < staleMs, last_seen: seen || null, waiting };
}

const view = (row) => ({
  write_id: row.id, status: row.status, saved: row.status === 'saved', path: row.path || null, error: row.error || null,
  ...(row.kind === 'session' ? { session_id: row.key.slice('session:'.length), revision: row.revision } : {}),
});

function message(row, writing) {
  if (row.status === 'saved') return 'Saved in their vault.';
  if (row.status === 'failed') return `Not saved: ${row.error}`;
  if (row.status === 'superseded') return 'Replaced by a newer update of the same session.';
  if (writing.online) return 'Queued; their vault machine is online and usually saves within seconds. Check with write_status.';
  return `Writing is paused: their vault machine is offline${writing.last_seen ? ` (last seen ${writing.last_seen})` : ''}. `
    + 'This write is queued and will be saved when it is back; reading still works. Tell them it is queued, not saved.';
}

// Put a write in the queue. An older update of the same key that hasn't been applied yet is replaced, not applied.
export async function enqueueWrite(env, { kind, key, revision, payload, source }) {
  const db = env.DB;
  const waiting = await db.prepare("SELECT COUNT(*) AS n FROM writes WHERE status IN ('queued', 'applying')").first('n');
  if (waiting >= MAX_QUEUE) throw new ToolError('Too many writes are waiting for the vault machine. Try again once it has caught up.');
  if (revision === undefined) revision = ((await db.prepare('SELECT MAX(revision) AS r FROM writes WHERE key = ?1').bind(key).first('r')) || 0) + 1;
  const id = 'w_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  const now = new Date().toISOString();
  try {
    await db.batch([
      db.prepare("UPDATE writes SET status = 'superseded', done_at = ?2 WHERE key = ?1 AND status = 'queued'").bind(key, now),
      db.prepare('INSERT INTO writes (id, kind, key, revision, payload, source, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
        .bind(id, kind, key, revision, JSON.stringify(payload), source || null, now),
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) throw new ToolError('Another update to this session arrived at the same moment. Send it again.');
    throw e;
  }
  return db.prepare('SELECT * FROM writes WHERE id = ?1').bind(id).first();
}

export function writeTools(env, cfg) {
  const db = env.DB;
  const byId = (id) => db.prepare('SELECT * FROM writes WHERE id = ?1').bind(id).first();

  // Report a write, first waiting a few seconds for the applier when it is online, so the AI can say "saved".
  async function report(row) {
    let writing = await writerStatus(env);
    const wait = env.WRITE_WAIT_MS !== undefined ? Number(env.WRITE_WAIT_MS) : 8000;
    if (writing.online && wait > 0 && ['queued', 'applying'].includes(row.status)) {
      const until = Date.now() + wait;
      while (Date.now() < until && ['queued', 'applying'].includes(row.status)) { await sleep(700); row = await byId(row.id); }
      writing = await writerStatus(env);
    }
    return { ...view(row), writing, message: message(row, writing) };
  }

  const enqueue = (w) => enqueueWrite(env, w);

  return {
    async log_session(a) {
      const title = text(a.title, 'title', 200).replace(BAD_NAME, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
      const summary = text(a.summary, 'summary', 3000);
      const kind = a.kind === 'study' ? 'study' : 'work';
      const category = CATEGORIES.includes(a.category) ? a.category : kind === 'study' ? 'study' : 'other';
      const lists = Object.fromEntries(['changes', 'decisions', 'still_unclear', 'next_steps', 'links'].map((k) => [k, items(a[k], k)]));
      let project = clip(a.project, 150).replace(/^\[\[|\]\]$/g, '');
      if (project) {
        const hit = await db.prepare('SELECT title FROM notes WHERE lower(title) = lower(?1) ORDER BY length(path) LIMIT 1').bind(project).first();
        if (!hit) throw new ToolError(`No note is titled "${project}". Find the exact title with search_notes, or leave project empty.`);
        project = hit.title;
      }
      const source = clip(a.source, 40).toLowerCase().replace(/[^a-z0-9-]/g, '') || 'ai';
      noSecrets(title, summary, lists);
      let sessionId = a.session_id;
      if (sessionId === undefined || sessionId === null || sessionId === '') sessionId = 'ses_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      else if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._:-]{8,100}$/.test(sessionId)) throw new ToolError('session_id must be 8–100 letters, digits or . _ : -');
      const key = 'session:' + sessionId;
      const prev = await db.prepare('SELECT * FROM writes WHERE key = ?1 ORDER BY revision DESC LIMIT 1').bind(key).first();
      const before = prev ? JSON.parse(prev.payload) : null;
      const now = localNow(cfg.tz);
      const payload = { session_id: sessionId, title, kind, category, project, summary, ...lists, source,
        date: before?.date || now.date, start: before?.start || now.time, end: now.time };
      if (before && JSON.stringify({ ...before, end: '' }) === JSON.stringify({ ...payload, end: '' }) && prev.status !== 'failed') return report(prev);
      return report(await enqueue({ kind: 'session', key, revision: (prev?.revision || 0) + 1, payload, source }));
    },

    async create_note(a) {
      const title = text(a.title, 'title', 120);
      if (BAD_NAME.test(title) || /[. ]$/.test(title) || /\.md$/i.test(title) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(title)
        || title.toLowerCase() === cfg.aboutNote.toLowerCase()) throw new ToolError('Use a plain note title of 1–120 characters, without .md or filename punctuation.');
      const folder = clip(a.folder, 351).replace(/^\/+|\/+$/g, '');
      const parts = folder.split('/');
      if (!folder || folder.length > 350 || parts.some((p) => !p || p.startsWith('.') || /[. ]$/.test(p) || BAD_NAME.test(p) || SYSTEM_FOLDER.test(p))
        || parts[0].toLowerCase() === cfg.sessionsFolder.split('/')[0].toLowerCase()) throw new ToolError('Choose an existing regular folder: not sessions, daily notes, templates, attachments or hidden folders.');
      const esc = folder.replace(/[\\%_]/g, (c) => '\\' + c);
      if (!(await db.prepare("SELECT 1 FROM notes WHERE folder = ?1 OR folder LIKE ?2 ESCAPE '\\' LIMIT 1").bind(folder, esc + '/%').first())) {
        throw new ToolError('That folder is not in their vault. Use a folder exactly as it appears in paths from list_notes or search_notes.');
      }
      const content = text(a.content, 'content', 20000);
      if (content.includes('\0')) throw new ToolError('content must be plain Markdown.');
      noSecrets(title, content);
      const path = `${folder}/${title}.md`;
      if (await db.prepare('SELECT 1 FROM notes WHERE lower(title) = lower(?1) OR lower(path) = lower(?2) LIMIT 1').bind(title, path).first()) {
        throw new ToolError('A note with this title already exists. Talisman never overwrites notes: pick another title, or read that note.');
      }
      const key = 'note:' + path.toLowerCase();
      const prev = await db.prepare("SELECT * FROM writes WHERE key = ?1 AND status != 'failed' ORDER BY revision DESC LIMIT 1").bind(key).first();
      if (prev) {
        const p = JSON.parse(prev.payload);
        if (p.content === content && p.title === title) return report(prev);
        throw new ToolError('A different note with this title is already waiting to be saved. Pick another title.');
      }
      const last = await db.prepare('SELECT MAX(revision) AS r FROM writes WHERE key = ?1').bind(key).first('r');
      const source = clip(a.source, 40).toLowerCase().replace(/[^a-z0-9-]/g, '') || 'ai';
      const payload = { title, folder, path, content, source, date: localNow(cfg.tz).date };
      return report(await enqueue({ kind: 'note', key, revision: (last || 0) + 1, payload, source }));
    },

    async write_status(a) {
      let row = null;
      if (typeof a.write_id === 'string' && a.write_id) row = await byId(a.write_id);
      else if (typeof a.session_id === 'string' && a.session_id) {
        row = await db.prepare('SELECT * FROM writes WHERE key = ?1 ORDER BY revision DESC LIMIT 1').bind('session:' + a.session_id).first();
      } else throw new ToolError('Send a write_id or a session_id.');
      if (!row) throw new ToolError('No write with that id.');
      const writing = await writerStatus(env);
      return { ...view(row), writing, message: message(row, writing) };
    },
  };
}

// ---------- the applier's side (bearer SYNC_TOKEN) ----------
//   POST /api/applier/claim  {name?, wait?: seconds ≤ 25}  → {writes: [...], config}   (also the heartbeat)
//   POST /api/applier/done   {id, status: saved|failed|retry, path?, error?, notes?: [mirror records]}
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

async function claim(env) {
  const now = Date.now(), iso = new Date(now).toISOString();
  await env.DB.prepare(`UPDATE writes SET status = 'failed', error = 'The vault machine could not save it after ${MAX_ATTEMPTS} tries.', done_at = ?2
    WHERE attempts >= ${MAX_ATTEMPTS} AND (status = 'queued' OR (status = 'applying' AND lease_until < ?1))`).bind(now, iso).run();
  const { results } = await env.DB.prepare(`UPDATE writes SET status = 'applying', lease_until = ?1, attempts = attempts + 1
    WHERE seq IN (SELECT seq FROM writes WHERE status = 'queued' OR (status = 'applying' AND lease_until < ?2) ORDER BY seq LIMIT 10)
    RETURNING seq, id, kind, key, revision, payload, source, created_at, attempts`).bind(now + LEASE_MS, now).all();
  return results.sort((x, y) => x.seq - y.seq).map(({ payload, ...w }) => ({ ...w, payload: JSON.parse(payload) }));
}

export async function applierApi(req, env, url, cfg) {
  // GET /api/applier/transcript/<capture_id>: a captured chat's transcript, fetched apart from the write so the queue stays light
  const t = url.pathname.match(/^\/api\/applier\/transcript\/([A-Za-z0-9._:-]{8,100})$/);
  if (t && req.method === 'GET') {
    const text = await env.DB.prepare('SELECT transcript FROM captures WHERE id = ?1').bind(t[1]).first('transcript');
    return text === null ? json({ error: 'unknown capture' }, 404)
      : new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  }
  if (req.method !== 'POST') return json({ error: 'not found' }, 404);
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== 'object') return json({ error: 'send a JSON body' }, 400);
  if (url.pathname === '/api/applier/claim') {
    const until = Date.now() + Math.min(Math.max(Number(b.wait) || 0, 0), 25) * 1000;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO meta (key, value) VALUES ('applier_seen', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(new Date().toISOString()),
      env.DB.prepare("INSERT INTO meta (key, value) VALUES ('applier_name', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(clip(b.name, 80) || 'applier'),
    ]);
    for (;;) {
      const writes = await claim(env);
      if (writes.length || Date.now() >= until) {
        return json({ writes, config: { owner: cfg.owner, time_zone: cfg.tz, sessions_folder: cfg.sessionsFolder, lease_seconds: LEASE_MS / 1000 } });
      }
      await sleep(1000);
    }
  }
  if (url.pathname === '/api/applier/done') {
    const row = typeof b.id === 'string' && await env.DB.prepare('SELECT * FROM writes WHERE id = ?1').bind(b.id).first();
    if (!row) return json({ error: 'unknown write' }, 404);
    if (!['saved', 'failed', 'retry'].includes(b.status)) return json({ error: 'status must be saved, failed or retry' }, 400);
    if (b.status === 'failed' && !clip(b.error, 300)) return json({ error: 'say why it failed' }, 400);
    if (row.status !== 'applying') return row.status === b.status ? json(view(row)) : json({ error: `this write is already ${row.status}` }, 409);
    let stmts;
    try { stmts = upsertNotes(env, Array.isArray(b.notes) ? b.notes.slice(0, 10) : []); } catch (e) { if (e instanceof BadNotes) return json({ error: e.message }, e.status); throw e; }
    const now = new Date().toISOString();
    if (b.status === 'retry') stmts.push(env.DB.prepare("UPDATE writes SET status = 'queued', lease_until = NULL, error = ?2 WHERE id = ?1").bind(row.id, clip(b.error, 300) || null));
    else stmts.push(env.DB.prepare('UPDATE writes SET status = ?2, path = ?3, error = ?4, lease_until = NULL, done_at = ?5 WHERE id = ?1')
      .bind(row.id, b.status, clip(b.path, 500) || null, b.status === 'failed' ? clip(b.error, 300) : null, now));
    await env.DB.batch(stmts);
    return json(view(await env.DB.prepare('SELECT * FROM writes WHERE id = ?1').bind(row.id).first()));
  }
  return json({ error: 'not found' }, 404);
}
