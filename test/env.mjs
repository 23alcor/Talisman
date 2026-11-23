// Shared test setup: a Worker env on the SQLite D1 stand-in, a KV stand-in, and request helpers.
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import worker from '../src/index.js';
import { addDays, localNow } from '../src/config.js';
import { database } from './d1.mjs';

export const SYNC_TOKEN = 'test-sync-token-0123456789';
export const TALISMAN_TOKEN = 'test-mcp-token-0123456789';
export const PASSWORD = 'correct horse battery';

export function passwordHash(pw, iterations = 1000) {
  const salt = randomBytes(16);
  return `pbkdf2-sha256$${iterations}$${salt.toString('base64')}$${pbkdf2Sync(pw, salt, iterations, 32, 'sha256').toString('base64')}`;
}

// Enough of Workers KV for the OAuth provider: get (text or json), put with TTL, delete, list by prefix.
export function kv() {
  const m = new Map();
  const live = (k) => { const e = m.get(k); if (e && e.exp && e.exp < Date.now()) { m.delete(k); return null; } return e || null; };
  return {
    _map: m,
    async get(k, opt) { const e = live(k); if (!e) return null; const type = typeof opt === 'string' ? opt : opt?.type; return type === 'json' ? JSON.parse(e.v) : e.v; },
    async put(k, v, opt = {}) { m.set(k, { v: String(v), exp: opt.expirationTtl ? Date.now() + opt.expirationTtl * 1000 : opt.expiration ? opt.expiration * 1000 : 0 }); },
    async delete(k) { m.delete(k); },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix) && live(k)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      const done = start + limit >= keys.length;
      return { keys: page.map((name) => ({ name })), list_complete: done, cursor: done ? undefined : String(start + limit) };
    },
  };
}

export function makeEnv(extra = {}) {
  return {
    DB: database(), SYNC_TOKEN, TALISMAN_TOKEN, OWNER_NAME: 'Sam', TIMEZONE: 'America/New_York', ABOUT_NOTE: 'About Me', SESSIONS_FOLDER: 'Sessions',
    PASSWORD_HASH: passwordHash(PASSWORD), SESSION_SECRET: 'test-session-secret', WRITE_WAIT_MS: 0, ...extra,
  };
}

export const ORIGIN = 'https://talisman.test';
const waits = [];
const ctx = { waitUntil: (p) => waits.push(p), passThroughOnException() {} };
export async function call(env, path, init = {}) {
  const res = await worker.fetch(new Request(ORIGIN + path, init), env, ctx);
  await Promise.all(waits.splice(0));
  return res;
}

export const putNotes = (env, body, token = SYNC_TOKEN) => call(env, '/api/sync/notes', {
  method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
});

let id = 0;
export async function rpc(env, method, params, token = TALISMAN_TOKEN) {
  const res = await call(env, '/mcp', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  return { status: res.status, headers: res.headers, body: res.status === 200 ? await res.json() : await res.text() };
}
// Calls a tool and returns {data, error}: data is the parsed JSON result, error the message of a failed call.
export async function tool(env, name, args = {}, token) {
  const { body } = await rpc(env, 'tools/call', { name, arguments: args }, token);
  const text = body.result.content[0].text;
  return body.result.isError ? { error: text } : { data: JSON.parse(text) };
}

// A small vault: an About Me note, two projects that link to each other, sessions, and a daily note.
export function sampleNotes() {
  const today = localNow('America/New_York').date;
  const day = (n) => addDays(today, -n);
  return [
    { path: 'About Me.md', title: 'About Me', tags: 'profile', updated_at: `${day(30)}T09:00`, body: '# About Me\n\nSam studies engineering and builds tools.\n\n## Goals\n\nShip [[Lantern]] by spring.' },
    { path: 'Projects/Lantern/Lantern.md', title: 'Lantern', tags: 'project', updated_at: `${day(1)}T10:00`, body: '# Lantern\n\nA reading lamp app. Uses [[Kiln]] for builds and [[Ideas/Offline first|offline-first]] sync.\n\n## Status\n\nBeta is out.\n\n## Risks\n\nBattery drain at 100% brightness.\n\n```\n## Not a heading\n```\n\n### Detail\n\nUnder risks.\n\n## Links\n\n![[diagram.png]]' },
    { path: 'Projects/Kiln/Kiln.md', title: 'Kiln', tags: 'project', updated_at: `${day(5)}T10:00`, body: '# Kiln\n\nBuild runner. Used by [[Lantern#Status]].\n\nSee also [[Projects/Lantern/Lantern|the lamp]].' },
    { path: 'Projects/Lantern/Sessions/' + day(2) + ' Lantern beta.md', title: `${day(2)} Lantern beta`, tags: 'session', updated_at: `${day(2)}T18:00`,
      body: '---\nproject: "[[Lantern]]"\n---\n# Beta\n\n## Summary\n\nShipped the beta build.\n\n## Next steps\n\n- Fix battery drain' },
    { path: 'Sessions/' + day(20) + ' Old session.md', title: `${day(20)} Old session`, tags: 'session', updated_at: `${day(20)}T18:00`, body: '## Summary\n\nLong ago.' },
    { path: 'Sessions/' + day(3) + ' Kiln cache.md', title: `${day(3)} Kiln cache`, tags: 'session', updated_at: `${day(3)}T12:00`, body: '---\nproject: "[[Kiln]]"\n---\n## Summary\n\nAdded a build cache to Kiln.\n\n## Review next\n\nCache eviction.' },
    { path: 'Daily/' + day(0) + '.md', title: day(0), tags: '', updated_at: `${day(0)}T08:00`, body: 'Thought about the lamp. 100 percent sure about [[Lantern]].' },
  ];
}

export async function seeded(extra) {
  const env = makeEnv(extra);
  const res = await putNotes(env, { notes: sampleNotes() });
  if (res.status !== 200) throw new Error('seeding failed: ' + (await res.text()));
  return env;
}
