// Capture: a hook in each coding agent (capture/talisman-capture.py) sends its chat here as it grows: one record per
// chat, keyed by a capture_id the hook derives from the agent's own session id. When a chat has been quiet for a while,
// or the agent says it ended, a model summarizes it (on the next cron run) and the summary goes into the write queue as that chat's session
// note (the same note is rewritten as the chat goes on), with the full transcript linked.
//
//   POST /api/capture  {capture_id, source, transcript, cwd?, started_at?, ended_at?, final?}   (bearer TALISMAN_TOKEN)
//
// Summaries use an OpenAI-compatible Responses API: OPENAI_API_KEY (secret), SUMMARY_MODEL, SUMMARY_BASE_URL and
// SUMMARY_REASONING (vars). A cron trigger sweeps for chats that have gone quiet.
import { localNow } from './config.js';
import { CATEGORIES, enqueueWrite, redactSecrets } from './writes.js';

const MAX_TRANSCRIPT = 1_500_000; // characters stored per chat
const MODEL_CHARS = 400_000;      // what the model reads; longer chats keep the start and the end
const STALE_MS = 10 * 60e3;       // a summary that hasn't finished by then is retried
const RETRY_MS = 15 * 60e3;
const MAX_ATTEMPTS = 3;
const ID = /^[A-Za-z0-9._:-]{8,100}$/;

const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '');
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const quietMs = (env) => Math.max(Number(env.CAPTURE_QUIET_MINUTES) || 10, 1) * 60e3;
const isoOrNull = (s) => (typeof s === 'string' && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null);

export async function receiveCapture(req, env, ctx, cfg) {
  if (req.method !== 'POST') return json({ error: 'not found' }, 404);
  const b = await req.json().catch(() => null);
  if (!b || typeof b.capture_id !== 'string' || !ID.test(b.capture_id)) return json({ error: 'capture_id must be 8–100 letters, digits or . _ : -' }, 400);
  if (typeof b.transcript !== 'string' || !b.transcript.trim()) return json({ error: 'transcript is required' }, 400);
  if (b.transcript.length > MAX_TRANSCRIPT) return json({ error: `transcript is over ${MAX_TRANSCRIPT} characters; send the start and the end` }, 413);
  // The hook strips private spans and redacts secret shapes before sending (re-scanning a large chat here would
  // cost more CPU than a Worker request gets); the summary written into notes is scanned again below.
  const transcript = b.transcript.trim();
  const source = clip(b.source, 40).toLowerCase().replace(/[^a-z0-9-]/g, '') || 'ai';
  const final = b.final === true ? 1 : 0;
  const now = Date.now(), iso = new Date(now).toISOString(), due = final ? now : now + quietMs(env);
  const started = isoOrNull(b.started_at), ended = isoOrNull(b.ended_at) || iso, cwd = clip(b.cwd, 500) || null;
  const db = env.DB;
  const row = await db.prepare('SELECT transcript, revision, final, status FROM captures WHERE id = ?1').bind(b.capture_id).first();
  let changed = true;
  if (!row) {
    await db.prepare(`INSERT INTO captures (id, source, cwd, transcript, started_at, ended_at, final, quiet_until, received_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`).bind(b.capture_id, source, cwd, transcript, started, ended, final, due, iso).run();
  } else if (row.transcript === transcript || row.transcript.startsWith(transcript)) {
    changed = false; // nothing new, or an older copy arriving late; "final" still brings a waiting summary forward
    if (final) await db.prepare("UPDATE captures SET final = 1, quiet_until = CASE WHEN status = 'waiting' THEN ?2 ELSE quiet_until END WHERE id = ?1").bind(b.capture_id, now).run();
  } else {
    await db.prepare(`UPDATE captures SET transcript = ?2, revision = revision + 1, started_at = COALESCE(started_at, ?3), ended_at = ?4,
      cwd = COALESCE(?5, cwd), final = MAX(final, ?6), status = 'waiting', quiet_until = ?7, attempts = 0, error = NULL, updated_at = ?8 WHERE id = ?1`)
      .bind(b.capture_id, transcript, started, ended, cwd, final, due, iso).run();
  }
  // An ended chat is due at once; the cron trigger (every few minutes) summarizes it. Not here: a long summary can
  // outlast the time a request gets after its response, and cron runs get far longer.
  const after = await db.prepare('SELECT revision, status, quiet_until FROM captures WHERE id = ?1').bind(b.capture_id).first();
  return json({ capture_id: b.capture_id, revision: after.revision, changed, status: after.status,
    summarize_after: after.status === 'waiting' ? new Date(after.quiet_until).toISOString() : null });
}

// ---------- summaries ----------
const LIST = (description) => ({ type: 'array', items: { type: 'string' }, description });
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'kind', 'category', 'target', 'summary', 'changed', 'decisions', 'next', 'covered', 'key_ideas', 'unclear', 'review', 'links', 'concepts'],
  properties: {
    title: { type: 'string', description: '2-6 words, outcome first' },
    kind: { type: 'string', enum: ['work', 'study'] },
    category: { type: 'string', enum: CATEGORIES },
    target: { type: 'string', description: 'Exact name of the best matching target, or an empty string' },
    summary: { type: 'string', description: '2-4 sentences' },
    changed: LIST('Work: concrete files, features and results'),
    decisions: LIST('Work: each choice made and why'),
    next: LIST('Work: open items'),
    covered: LIST('Study: topics, problems or chapters worked through'),
    key_ideas: LIST('Study: the core points learned'),
    unclear: LIST('Study: what was confusing or got wrong'),
    review: LIST('Study: what to revisit'),
    links: LIST('URLs, repos, pull requests and commit hashes mentioned'),
    concepts: LIST('At most 5 key concepts, sentence case'),
  },
};

// Projects, courses and areas in the vault (notes with `type: project|course|area`), with short hints for matching.
export async function captureTargets(env) {
  const { results } = await env.DB.prepare(
    "SELECT title, body FROM notes WHERE body LIKE '---%' AND (body LIKE ?1 OR body LIKE ?2 OR body LIKE ?3) ORDER BY updated_at DESC LIMIT 150"
  ).bind('%type: project%', '%type: course%', '%type: area%').all();
  const out = [];
  for (const n of results) {
    const fm = (n.body.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
    const prop = (k) => ((fm.match(new RegExp(`^${k}:\\s*(.*)$`, 'm')) || [])[1] || '').trim().replace(/^["']|["']$/g, '');
    const kind = prop('type');
    if (!['project', 'course', 'area'].includes(kind)) continue;
    const aliases = prop('aliases').replace(/^\[|\]$/g, '');
    const first = (n.body.slice(n.body.indexOf('---', 3) + 3).split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || '').slice(0, 120);
    out.push({ name: n.title, kind, hint: [prop('code'), aliases, first].filter(Boolean).join('; ').slice(0, 240) });
  }
  return out;
}

function instructions(cfg, targets) {
  const who = cfg.owner || 'the owner';
  return [
    `You turn the raw transcript of one work or study session (usually a chat with an AI assistant or coding agent) into a short session note for ${who}'s notes. Answer only with JSON that matches the schema.`,
    'title: 2-6 words, outcome first. Do not use any of these characters: : / \\ # ^ | [ ] ? * " < >',
    'kind: "study" when they were learning (coursework, homework, exam prep, practice problems, reading papers); otherwise "work".',
    'category: call (a phone or video call), interview, meeting, lecture, coding (building or debugging software with a tool), study (self-study, homework, practice problems), research (papers, experiments), writing (documents, resumes, posts), planning (organizing plans or systems), or other.',
    'target: copy the name of the best matching note from TARGETS exactly, using the hints and the working directory. If nothing fits, use "".',
    `summary: 2-4 sentences, outcome first, past tense, written for ${who} reading it a month from now.`,
    "Work sessions fill changed, decisions and next; study sessions fill covered, key_ideas, unclear and review. Leave the other kind's lists empty. One line per item, concrete, no filler.",
    'links: URLs, repos, pull requests and commit hashes that appear in the transcript. concepts: at most 5 key ideas or technologies as plain sentence-case names, e.g. "Gradient descent".',
    'Never copy secrets (passwords, API keys, tokens, account or card numbers) into any field.',
    '', 'TARGETS (name · kind · hint):',
    ...(targets.length ? targets.map((x) => `- ${x.name} · ${x.kind}${x.hint ? ' · ' + x.hint : ''}`) : ['(none yet, so use "")']),
  ].join('\n');
}

function transcriptInput(c) {
  let text = c.transcript;
  if (text.length > MODEL_CHARS) {
    const head = 60_000;
    text = text.slice(0, head) + `\n\n[... ${(text.length - MODEL_CHARS).toLocaleString()} characters cut from the middle ...]\n\n` + text.slice(-(MODEL_CHARS - head));
  }
  const meta = [`Source: ${c.source || 'unknown'}`];
  if (c.cwd) meta.push(`Working directory: ${c.cwd}`);
  if (c.started_at || c.ended_at) meta.push(`Session: ${c.started_at || '?'} to ${c.ended_at || '?'}`);
  return [{ role: 'user', content: meta.join('\n') + '\n\nTRANSCRIPT:\n' + text }];
}

async function callModel(env, cfg, c, targets) {
  if (!env.OPENAI_API_KEY) throw new Error('Summaries need an API key: set the OPENAI_API_KEY secret.');
  const effort = env.SUMMARY_REASONING || 'low';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 240_000);
  try {
    const res = await fetch(`${(env.SUMMARY_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')}/responses`, {
      method: 'POST', signal: ctrl.signal,
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.SUMMARY_MODEL || 'gpt-5-mini',
        instructions: instructions(cfg, targets),
        input: transcriptInput(c),
        text: { format: { type: 'json_schema', name: 'session_note', schema: SCHEMA, strict: true } },
        max_output_tokens: 8000, store: false,
        ...(effort === 'off' ? {} : { reasoning: { effort } }),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) throw new Error('The model provider rejected the API key (OPENAI_API_KEY).');
      if (res.status === 429) throw new Error('The model provider says you hit a rate limit or ran out of credits.');
      throw new Error(`Model error ${res.status}: ${String(data?.error?.message || 'unknown').slice(0, 200)}`);
    }
    const text = (Array.isArray(data.output) ? data.output : []).filter((i) => i.type === 'message').flatMap((i) => i.content || [])
      .filter((x) => x.type === 'output_text').map((x) => x.text).join('');
    if (!text) throw new Error(data.status === 'incomplete' ? 'The summary got cut off.' : 'The model returned no summary.');
    try { return JSON.parse(text); } catch { throw new Error('The model returned something that was not a summary.'); }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The model took too long.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// The summary as a session write, in the same shape log_session uses.
export function sessionPayload(cfg, c, s, targets) {
  const list = (v, n = 12) => (Array.isArray(v) ? v : []).map((x) => redactSecrets(clip(String(x ?? ''), 400))).filter(Boolean).slice(0, n);
  const study = s.kind === 'study';
  const target = targets.find((t) => t.name.toLowerCase() === clip(s.target, 200).toLowerCase())?.name || '';
  const at = (iso) => localNow(cfg.tz, new Date(iso || Date.now()));
  const start = at(c.started_at), end = at(c.ended_at);
  return {
    session_id: 'cap_' + c.id,
    title: clip(String(s.title || ''), 80).replace(/[:/\\#^|[\]?*"<>]/g, ' ').replace(/\s+/g, ' ').trim() || 'Session',
    kind: study ? 'study' : 'work',
    category: CATEGORIES.includes(s.category) ? s.category : 'other',
    project: target,
    summary: redactSecrets(clip(String(s.summary || ''), 2000)) || 'No summary.',
    changes: list(study ? s.covered : s.changed), decisions: list(study ? s.key_ideas : s.decisions),
    still_unclear: study ? list(s.unclear) : [], next_steps: list(study ? s.review : s.next),
    links: list(s.links, 20), concepts: list(s.concepts, 5).map((x) => x.replace(/[[\]|#^]/g, '').trim()).filter(Boolean),
    source: c.source || 'ai', date: start.date, start: start.time, end: end.time,
    transcript_capture: c.id,
  };
}

// Summarize chats that have gone quiet (or ended) and queue their session notes. Run by the cron trigger.
// Each chat is claimed first, so two runs never summarize the same one.
export async function summarizeDue(env, cfg, limit = 3) {
  const db = env.DB, now = Date.now();
  if (!env.OPENAI_API_KEY) return { summarized: 0, reason: 'no OPENAI_API_KEY' };
  const { results } = await db.prepare(`UPDATE captures SET status = 'summarizing', claimed_at = ?1, attempts = attempts + 1
    WHERE id IN (SELECT id FROM captures WHERE (status = 'waiting' AND quiet_until <= ?1) OR (status = 'summarizing' AND claimed_at < ?2)
                 ORDER BY quiet_until LIMIT ?3)
    RETURNING id, source, cwd, transcript, started_at, ended_at, revision, attempts`).bind(now, now - STALE_MS, limit).all();
  if (!results.length) return { summarized: 0 };
  const targets = await captureTargets(env);
  let summarized = 0;
  for (const c of results) {
    try {
      const s = await callModel(env, cfg, c, targets);
      const payload = sessionPayload(cfg, c, s, targets);
      await enqueueWrite(env, { kind: 'session', key: 'session:' + payload.session_id, payload, source: payload.source });
      await db.prepare(`UPDATE captures SET summarized_rev = ?2, attempts = 0, error = NULL,
        status = CASE WHEN revision = ?2 THEN 'done' ELSE 'waiting' END WHERE id = ?1`).bind(c.id, c.revision).run();
      summarized++;
    } catch (e) {
      console.error('capture summary', c.id, e?.message);
      const giveUp = c.attempts >= MAX_ATTEMPTS;
      await db.prepare(`UPDATE captures SET error = ?2, quiet_until = ?3,
        status = CASE WHEN revision = ?4 THEN ?5 ELSE 'waiting' END WHERE id = ?1`)
        .bind(c.id, clip(String(e?.message || e), 300), Date.now() + RETRY_MS, c.revision, giveUp ? 'error' : 'waiting').run();
    }
  }
  return { summarized };
}
