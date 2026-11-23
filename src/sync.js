// The read mirror's write side, used only by the vault machine (SYNC_TOKEN):
//   GET /api/sync/notes  → {hashes: {path: hash}, synced_at} so the client sends only what changed
//   PUT /api/sync/notes  {notes: [{path, title?, folder?, tags?, updated_at?, hash?, body}], keep?: [path]}
//        upserts the notes; with `keep`, every stored note not listed is removed (it was deleted from the vault).
const MAX_NOTE = 200_000; // bytes per note
const MAX_BATCH = 500;

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const bad = (msg, status = 400) => json({ error: msg }, status);
const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '');

export const validPath = (p) => typeof p === 'string' && p.length <= 500 && p.endsWith('.md') && !p.startsWith('/') && !p.includes('\\')
  && !p.split('/').some((part) => part === '..' || part === '.' || part === '');

export class BadNotes extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Statements that upsert these notes into the mirror. Throws BadNotes before anything is written.
export function upsertNotes(env, notes) {
  const enc = new TextEncoder();
  return notes.map((n) => {
    const path = n?.path, body = typeof n?.body === 'string' ? n.body : '';
    if (!validPath(path)) throw new BadNotes(`bad path: ${clip(path, 200) || '(empty)'}`);
    if (enc.encode(body).length > MAX_NOTE) throw new BadNotes(`${path} is over ${MAX_NOTE / 1000} KB`, 413);
    return env.DB.prepare(
      `INSERT INTO notes (path, title, folder, tags, updated_at, hash, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(path) DO UPDATE SET title = ?2, folder = ?3, tags = ?4, updated_at = ?5, hash = ?6, body = ?7`
    ).bind(path, clip(n.title, 300) || path.split('/').pop().replace(/\.md$/, ''), clip(n.folder, 500) || path.split('/').slice(0, -1).join('/'),
      clip(n.tags, 1000), clip(n.updated_at, 16) || null, clip(n.hash, 128) || null, body);
  });
}

export async function syncNotes(req, env) {
  if (req.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT path, hash FROM notes').all();
    const synced = await env.DB.prepare("SELECT value FROM meta WHERE key = 'last_sync'").first('value');
    return json({ hashes: Object.fromEntries(results.map((r) => [r.path, r.hash])), synced_at: synced || null });
  }
  if (req.method !== 'PUT') return bad('not found', 404);
  const b = await req.json().catch(() => null);
  if (!b || !Array.isArray(b.notes) || b.notes.length > MAX_BATCH) return bad(`send {"notes": [...]} with up to ${MAX_BATCH} notes`);
  let stmts;
  try { stmts = upsertNotes(env, b.notes); } catch (e) { if (e instanceof BadNotes) return bad(e.message, e.status); throw e; }
  let removed = 0;
  if (Array.isArray(b.keep) && b.keep.length) { // an empty list never wipes the mirror
    const keep = new Set(b.keep.concat(b.notes.map((n) => n.path)));
    const { results } = await env.DB.prepare('SELECT path FROM notes').all();
    for (const r of results) if (!keep.has(r.path)) { stmts.push(env.DB.prepare('DELETE FROM notes WHERE path = ?1').bind(r.path)); removed++; }
  }
  stmts.push(env.DB.prepare("INSERT INTO meta (key, value) VALUES ('last_sync', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(new Date().toISOString()));
  await env.DB.batch(stmts);
  return json({ ok: true, saved: b.notes.length, removed });
}
