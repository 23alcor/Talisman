// The connector's read tools. They answer from the read mirror (the `notes` table), never from the vault itself,
// so they keep working when the owner's computers are off. Every result says how fresh the mirror is.
import { addDays, localNow } from './config.js';

export class ToolError extends Error {}

const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '');
const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const tool = (name, description, properties = {}, required = []) => ({
  name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
});

export const READ_TOOLS = [
  tool('whoami', 'Who the owner is: their About Me note (background, work, projects, goals, how they like answers), plus the current date, time and time zone, and how fresh the notes mirror is. Use it when the answer depends on who they are or what they are working on.'),
  tool('search_notes', 'Search their notes (projects, courses, areas, session notes, daily notes) by words. Returns paths and matching snippets; read a note with read_note.', {
    query: S('Words to look for'), folder: S('Optional folder prefix to search within'), limit: { type: 'integer', description: 'Max results, default 5, up to 10' },
  }, ['query']),
  tool('read_note', 'Read a bounded part of a note. Prefer a named section; use next_offset to continue. Default 4000 characters, maximum 12000. Takes a path or a note title.', {
    path: S('Note path or title'), section: S('Exact heading text, without #'), offset: { type: 'integer', minimum: 0 }, max_chars: { type: 'integer', minimum: 200, maximum: 12000 },
  }, ['path']),
  tool('list_notes', 'List their notes, newest first: path, title, tags, last edit.', {
    folder: S('Optional folder prefix'), limit: { type: 'integer', description: 'Default 50, up to 300' },
  }),
  tool('related_notes', 'Follow the links between their notes (the knowledge graph): what a note links to, and every note that links to it, with the line around each link. Works for concepts without a note of their own too. Use it to widen from one note to related projects, sessions and ideas.', {
    note: S('A note title or path, or a concept name'),
  }, ['note']),
  tool('recent_sessions', 'Their recent work and study sessions (session notes): what got done, decisions and next steps. Use for "what have I been working on" or to pick up where a project left off.', {
    limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Default 5 sessions' }, days: { type: 'integer', description: 'How far back, default 7, up to 90' },
    project: S('Optional project, course or area name'),
  }),
];

const words = (q) => [...new Set((clip(q, 200).toLowerCase().match(/[\p{L}\p{N}_'-]+/gu) || []))].slice(0, 8);
const like = (w) => '%' + w.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
const folderLike = (f) => clip(f, 200).replace(/^\/+|\/+$/g, '').replace(/[\\%_]/g, (c) => '\\' + c) + '/%';

function snippet(body, ws) {
  const lower = body.toLowerCase();
  const hits = ws.map((w) => lower.indexOf(w)).filter((i) => i >= 0);
  const at = hits.length ? Math.min(...hits) : 0;
  return (at > 80 ? '…' : '') + body.slice(Math.max(0, at - 80), at + 160).replace(/\s+/g, ' ').trim() + '…';
}

const sectionOf = (body, heading) => {
  const m = body.match(new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'));
  return m ? m[1].trim().slice(0, 800) : undefined;
};

// [[Target]], [[Target|label]], [[Target#heading]], [[Folder/Target]]; ![[embeds]] of non-notes (images, .base) are skipped.
const LINK = /(!?)\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
export const linksIn = (body) => [...new Set([...body.matchAll(LINK)].filter((m) => !(m[1] && /\.\w+$/.test(m[2]))).map((m) => m[2].trim()).filter(Boolean))];
// LIKE patterns for a link to `title`: [[Title]], [[Title|…]], [[Title#…]] and path-style [[Folder/Title…]].
const linkPatterns = (title) => {
  const t = title.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c);
  return [']]', '|', '#'].flatMap((end) => [`%[[${t}${end}%`, `%[[%/${t}${end}%`]);
};

// One heading's section of a note, fenced code blocks ignored, up to the next heading of the same or higher level.
export function noteSection(body, heading) {
  if (typeof heading !== 'string' || heading.length > 200) throw new ToolError('section must be a heading of at most 200 characters.');
  const lines = body.split('\n');
  let fence = null, start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) { if (!fence) fence = f[1]; else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; continue; }
    if (fence) continue;
    const h = lines[i].match(/^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/);
    if (!h) continue;
    if (start >= 0 && h[1].length <= level) return lines.slice(start, i).join('\n').trimEnd();
    if (start < 0 && h[2] === heading.trim()) { start = i; level = h[1].length; }
  }
  if (start >= 0) return lines.slice(start).join('\n');
  throw new ToolError('Section not found. Read the beginning of the note to find its heading.');
}

export async function mirrorStatus(db) {
  const synced = await db.prepare("SELECT value FROM meta WHERE key = 'last_sync'").first('value');
  const notes = await db.prepare('SELECT COUNT(*) AS n FROM notes').first('n');
  return { notes, synced_at: synced || null };
}

export function readTools(env, cfg) {
  const db = env.DB;
  const note = async (p) => {
    const path = clip(p, 500);
    return (await db.prepare('SELECT * FROM notes WHERE path = ?1').bind(path).first())
      || (await db.prepare('SELECT * FROM notes WHERE lower(title) = lower(?1) ORDER BY length(path) LIMIT 1').bind(path.replace(/\.md$/i, '')).first());
  };
  return {
    async whoami() {
      const about = await db.prepare('SELECT path, body FROM notes WHERE lower(title) = lower(?1) ORDER BY length(path) LIMIT 1').bind(cfg.aboutNote).first();
      return {
        name: cfg.owner || null, now: localNow(cfg.tz), time_zone: cfg.tz, mirror: await mirrorStatus(db),
        about_me_path: about?.path || null,
        about_me_truncated: (about?.body.length || 0) > 4000,
        about_me: about?.body.slice(0, 4000) || `No "${cfg.aboutNote}" note yet. Use search_notes and recent_sessions to learn about them.`,
      };
    },
    async search_notes(a) {
      // A LIKE scan: fine for a few thousand notes. Full-text and meaning-based search come later (roadmap).
      const ws = words(a.query);
      if (!ws.length) throw new ToolError('query needs at least one word');
      const limit = Math.min(Math.max(+a.limit || 5, 1), 10);
      const args = [], where = [];
      for (const w of ws) { args.push(like(w)); where.push(`(lower(title) LIKE ?${args.length} ESCAPE '\\' OR lower(tags) LIKE ?${args.length} ESCAPE '\\' OR lower(body) LIKE ?${args.length} ESCAPE '\\')`); }
      if (a.folder) { args.push(folderLike(a.folder)); where.push(`path LIKE ?${args.length} ESCAPE '\\'`); }
      const { results } = await db.prepare(`SELECT path, title, tags, updated_at, body FROM notes WHERE ${where.join(' AND ')}`).bind(...args).all();
      const titleHits = (n) => ws.filter((w) => n.title.toLowerCase().includes(w)).length;
      results.sort((x, y) => titleHits(y) - titleHits(x) || String(y.updated_at).localeCompare(String(x.updated_at)));
      return { query: a.query, total: results.length, results: results.slice(0, limit).map((n) => ({ path: n.path, title: n.title, tags: n.tags, updated_at: n.updated_at, snippet: snippet(n.body, ws) })) };
    },
    async read_note(a) {
      const [path, fragment] = typeof a.path === 'string' ? a.path.split('#', 2) : [];
      const n = await note(path);
      if (!n) throw new ToolError('No note with that path or title. Use search_notes or list_notes.');
      const section = a.section || fragment;
      const source = section ? noteSection(n.body, section) : n.body;
      const offset = a.offset ?? 0, max = a.max_chars ?? 4000;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(max) || max < 200 || max > 12000) throw new ToolError('Use a nonnegative offset and max_chars between 200 and 12000.');
      let end = Math.min(source.length, offset + max);
      if (end < source.length && /[\uD800-\uDBFF]/.test(source[end - 1] || '')) end--;
      const truncated = end < source.length;
      return { path: n.path, title: n.title, tags: n.tags, updated_at: n.updated_at, section: section || null, body: source.slice(offset, end), offset, next_offset: truncated ? end : null, truncated };
    },
    async list_notes(a) {
      const limit = Math.min(Math.max(+a.limit || 50, 1), 300);
      const args = [limit];
      let where = '1';
      if (a.folder) { args.push(folderLike(a.folder)); where = `path LIKE ?${args.length} ESCAPE '\\'`; }
      const { results } = await db.prepare(`SELECT path, title, tags, updated_at FROM notes WHERE ${where} ORDER BY updated_at DESC LIMIT ?1`).bind(...args).all();
      return { notes: results };
    },
    async related_notes(a) {
      // Links are parsed at query time with LIKE scans: fine for a few thousand notes; store them at sync if it grows.
      const name = clip(a.note, 300);
      if (!name) throw new ToolError('note is required');
      const n = await note(name);
      const title = n?.title || name.replace(/\.md$/i, '').split('/').pop();
      const resolved = [];
      for (const t of (n ? linksIn(n.body) : []).slice(0, 60)) {
        const hit = await note(t.includes('/') ? t + '.md' : t);
        resolved.push({ title: t.split('/').pop(), path: hit?.path || null });
      }
      const pats = linkPatterns(title);
      const { results } = await db.prepare(
        `SELECT path, title, body FROM notes WHERE (${pats.map((_, i) => `lower(body) LIKE ?${i + 1} ESCAPE '\\'`).join(' OR ')}) ${n ? `AND path != ?${pats.length + 1}` : ''}
         ORDER BY updated_at DESC LIMIT 30`
      ).bind(...pats, ...(n ? [n.path] : [])).all();
      const lower = title.toLowerCase();
      return {
        note: n ? { path: n.path, title: n.title } : { title, path: null, has_own_note: false },
        links_to: resolved.filter((r) => r.path), mentions_without_note: resolved.filter((r) => !r.path).map((r) => r.title),
        linked_from: results.map((r) => ({
          path: r.path, title: r.title,
          context: (r.body.split('\n').find((l) => linksIn(l).some((t) => t.toLowerCase().split('/').pop() === lower)) || '').trim().slice(0, 240),
        })),
      };
    },
    async recent_sessions(a) {
      const days = Math.min(Math.max(+a.days || 7, 1), 90);
      const since = addDays(localNow(cfg.tz).date, -days);
      const folder = cfg.sessionsFolder.replace(/[\\%_]/g, (c) => '\\' + c);
      const args = [since, `${folder}/%`, `%/${folder}/%`];
      let where = "(path LIKE ?2 ESCAPE '\\' OR path LIKE ?3 ESCAPE '\\') AND path NOT LIKE '%/Transcripts/%' AND substr(updated_at, 1, 10) >= ?1";
      if (a.project) { // the session's folder, or its `project: "[[…]]"` property
        const p = clip(a.project, 120).replace(/^\[\[|\]\]$/g, '');
        args.push(`%/${p}%/${folder}/%`, `%project: "[[${p}%`);
        where += ` AND (path LIKE ?${args.length - 1} OR body LIKE ?${args.length})`;
      }
      const limit = Math.min(Math.max(Math.floor(+a.limit || 5), 1), 10);
      const { results } = await db.prepare(`SELECT path, title, updated_at, body FROM notes WHERE ${where} ORDER BY title DESC LIMIT ${limit}`).bind(...args).all();
      return {
        since, sessions: results.map((n) => ({
          path: n.path, title: n.title, summary: sectionOf(n.body, 'Summary'),
          next_steps: sectionOf(n.body, 'Next steps') ?? sectionOf(n.body, 'Review next'),
        })),
      };
    },
  };
}
