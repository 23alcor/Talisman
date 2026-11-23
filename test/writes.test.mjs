import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYNC_TOKEN, call, seeded, tool } from './env.mjs';

const applier = async (env, path, body, token = SYNC_TOKEN) => {
  const res = await call(env, '/api/applier/' + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const claim = async (env) => (await applier(env, 'claim', { name: 'test', wait: 0 })).body;
const session = (extra = {}) => ({ title: 'Ship the beta', summary: 'Shipped the beta build to testers.', project: 'Lantern', changes: ['Built it'], next_steps: ['Fix battery'], source: 'claude', ...extra });

test('only the vault machine can use the applier API', async () => {
  const env = await seeded();
  assert.equal((await applier(env, 'claim', {}, 'nope')).status, 401);
  assert.equal((await applier(env, 'claim', {}, env.TALISMAN_TOKEN)).status, 401);
  assert.equal((await applier(env, 'claim', {})).status, 200);
});

test('with the vault machine offline, writes queue and the AI is told writing is paused', async () => {
  const env = await seeded();
  const { data } = await tool(env, 'log_session', session());
  assert.equal(data.status, 'queued');
  assert.equal(data.saved, false);
  assert.equal(data.writing.online, false);
  assert.match(data.message, /Writing is paused.*queued.*reading still works/);
  assert.match(data.session_id, /^ses_/);
  assert.equal((await tool(env, 'whoami')).data.writing.waiting, 1);
});

test('the applier claims writes in order, saves them, and the mirror updates at once', async () => {
  const env = await seeded();
  const a = (await tool(env, 'log_session', session())).data;
  const b = (await tool(env, 'create_note', { title: 'Lamp ideas', folder: 'Projects/Lantern', content: 'Warm light. See [[Lantern]].' })).data;
  const got = await claim(env);
  assert.deepEqual(got.writes.map((w) => w.id), [a.write_id, b.write_id]);
  assert.equal(got.writes[0].kind, 'session');
  assert.equal(got.writes[0].payload.project, 'Lantern');
  assert.equal(got.config.sessions_folder, 'Sessions');
  assert.equal((await claim(env)).writes.length, 0); // claimed writes aren't handed out twice
  const path = 'Projects/Lantern/Lamp ideas.md';
  const done = await applier(env, 'done', { id: b.write_id, status: 'saved', path, notes: [{ path, title: 'Lamp ideas', body: '# Lamp ideas\nWarm light.' }] });
  assert.equal(done.body.saved, true);
  assert.match((await tool(env, 'read_note', { path: 'Lamp ideas' })).data.body, /Warm light/);
  const status = (await tool(env, 'write_status', { write_id: b.write_id })).data;
  assert.equal(status.saved, true);
  assert.equal(status.path, path);
  assert.equal(status.writing.online, true); // the claim was a heartbeat
  assert.equal((await applier(env, 'done', { id: b.write_id, status: 'saved' })).status, 200); // a repeated report is harmless
  assert.equal((await applier(env, 'done', { id: b.write_id, status: 'failed', error: 'x' })).status, 409);
});

test('updating a session: one session_id, rising revisions, unapplied older updates are replaced', async () => {
  const env = await seeded();
  const first = (await tool(env, 'log_session', session())).data;
  const second = (await tool(env, 'log_session', session({ session_id: first.session_id, summary: 'Shipped the beta and fixed the battery.' }))).data;
  assert.equal(second.revision, 2);
  assert.equal((await tool(env, 'write_status', { write_id: first.write_id })).data.status, 'superseded');
  const same = (await tool(env, 'log_session', session({ session_id: first.session_id, summary: 'Shipped the beta and fixed the battery.' }))).data;
  assert.equal(same.write_id, second.write_id); // nothing new to save
  const got = await claim(env);
  assert.deepEqual(got.writes.map((w) => [w.payload.session_id, w.revision]), [[first.session_id, 2]]);
  assert.match(got.writes[0].payload.date, /^\d{4}-\d\d-\d\d$/); // the session keeps the date and start time of its first save
  assert.match(got.writes[0].payload.start, /^\d\d:\d\d$/);
  assert.equal((await tool(env, 'write_status', { session_id: first.session_id })).data.revision, 2);
  const own = (await tool(env, 'log_session', session({ session_id: 'chat-1234-abcd' }))).data; // the AI may pick its own id
  assert.equal(own.session_id, 'chat-1234-abcd');
  assert.match((await tool(env, 'log_session', session({ session_id: 'x' }))).error, /session_id must be/);
});

test('a failed or interrupted write is retried, then given up on', async () => {
  const env = await seeded();
  const w = (await tool(env, 'log_session', session())).data;
  let got = await claim(env);
  await applier(env, 'done', { id: w.write_id, status: 'retry', error: 'disk busy' });
  got = await claim(env);
  assert.equal(got.writes[0].attempts, 2);
  // the applier vanished mid-write: once the lease runs out, the write is handed out again
  env.DB.raw.prepare('UPDATE writes SET lease_until = 0').run();
  got = await claim(env);
  assert.equal(got.writes[0].attempts, 3);
  env.DB.raw.prepare('UPDATE writes SET lease_until = 0, attempts = 5').run();
  assert.equal((await claim(env)).writes.length, 0);
  const s = (await tool(env, 'write_status', { write_id: w.write_id })).data;
  assert.equal(s.status, 'failed');
  assert.match(s.message, /Not saved: .*5 tries/);
  assert.equal((await applier(env, 'done', { id: w.write_id, status: 'saved' })).status, 409); // a late report can't revive it
});

test('log_session checks its input and refuses secrets', async () => {
  const env = await seeded();
  assert.match((await tool(env, 'log_session', session({ project: 'Nope' }))).error, /No note is titled "Nope"/);
  assert.equal((await tool(env, 'log_session', session({ project: '[[lantern]]' }))).data.status, 'queued'); // brackets and case are fine
  assert.match((await tool(env, 'log_session', { title: 'x' })).error, /summary is required/);
  assert.match((await tool(env, 'log_session', session({ changes: 'not a list' }))).error, /list/);
  for (const secret of ['sk-abcdefghijklmnopqrstuvwxyz123456', 'ghp_' + 'a'.repeat(36), 'password: hunter2hunter2hunter2', 'AKIAABCDEFGHIJKLMNOP']) {
    assert.match((await tool(env, 'log_session', session({ changes: [`used ${secret}`] }))).error, /never saves secrets/, secret);
  }
  assert.equal((await tool(env, 'log_session', session({ changes: ['rotated the token used by the sync client'] }))).data.status, 'queued'); // talking about tokens is fine
  const t = (await claim(env)).writes.map((w) => w.payload.title);
  assert.ok(t.every((x) => x === 'Ship the beta'));
});

test('create_note only creates new notes in existing, regular folders', async () => {
  const env = await seeded();
  const ok = { title: 'Lamp ideas', folder: 'Projects/Lantern', content: 'Ideas.' };
  assert.match((await tool(env, 'create_note', { ...ok, title: 'Lantern' })).error, /already exists/);
  assert.match((await tool(env, 'create_note', { ...ok, folder: 'Projects/Nowhere' })).error, /not in their vault/);
  assert.equal((await tool(env, 'create_note', { ...ok, folder: 'Projects' })).data.status, 'queued'); // a folder holding only folders counts
  for (const folder of ['Sessions', 'Sessions/2026-11', 'Templates', '.obsidian', 'Projects/../x', '']) {
    assert.ok((await tool(env, 'create_note', { ...ok, title: 'Other ' + folder.length, folder })).error, folder);
  }
  for (const title of ['a/b', 'x.md', 'About Me', 'trailing.', 'con', '[[x]]']) {
    assert.match((await tool(env, 'create_note', { ...ok, title, folder: 'Projects/Kiln' })).error, /plain note title|already exists/, title);
  }
  const first = (await tool(env, 'create_note', { ...ok, title: 'Kiln notes', folder: 'Projects/Kiln' })).data;
  assert.equal((await tool(env, 'create_note', { ...ok, title: 'Kiln notes', folder: 'Projects/Kiln' })).data.write_id, first.write_id); // a resend is the same write
  assert.match((await tool(env, 'create_note', { ...ok, title: 'Kiln notes', folder: 'Projects/Kiln', content: 'Different.' })).error, /already waiting/);
  assert.match((await tool(env, 'create_note', { ...ok, content: 'key: ' + 'sk-' + 'x'.repeat(30) })).error, /secrets/);
});
