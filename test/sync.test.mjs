import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYNC_TOKEN, call, makeEnv, putNotes, seeded } from './env.mjs';

const getHashes = async (env) => (await call(env, '/api/sync/notes', { headers: { authorization: `Bearer ${SYNC_TOKEN}` } })).json();

test('the sync API needs the sync token, and the connector token is not enough', async () => {
  const env = makeEnv();
  assert.equal((await call(env, '/api/sync/notes')).status, 401);
  assert.equal((await putNotes(env, { notes: [] }, 'wrong')).status, 401);
  assert.equal((await putNotes(env, { notes: [] }, env.TALISMAN_TOKEN)).status, 401);
  assert.equal((await call(makeEnv({ SYNC_TOKEN: '' }), '/api/sync/notes', { headers: { authorization: 'Bearer ' } })).status, 401);
});

test('notes are saved, and GET reports their hashes and the last sync', async () => {
  const env = makeEnv();
  const res = await putNotes(env, { notes: [{ path: 'A/B.md', body: 'hello', hash: 'h1', updated_at: '2026-01-02T03:04' }] });
  assert.deepEqual(await res.json(), { ok: true, saved: 1, removed: 0 });
  const row = await env.DB.prepare('SELECT * FROM notes WHERE path = ?1').bind('A/B.md').first();
  assert.equal(row.title, 'B'); // defaults from the path
  assert.equal(row.folder, 'A');
  const got = await getHashes(env);
  assert.deepEqual(got.hashes, { 'A/B.md': 'h1' });
  assert.match(got.synced_at, /^\d{4}-\d\d-\d\dT/);
  await putNotes(env, { notes: [{ path: 'A/B.md', body: 'changed', hash: 'h2' }] });
  assert.equal((await getHashes(env)).hashes['A/B.md'], 'h2');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM notes').first('n')), 1);
});

test('unsafe or non-note paths are refused and nothing is saved', async () => {
  const env = makeEnv();
  for (const path of ['../x.md', '/abs.md', 'a/./b.md', 'a//b.md', 'a\\b.md', 'notes.txt', '', 'x'.repeat(498) + '.md']) {
    const res = await putNotes(env, { notes: [{ path: 'ok.md', body: 'fine' }, { path, body: 'x' }] });
    assert.equal(res.status, 400, path);
  }
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM notes').first('n'), 0);
});

test('bad bodies, oversized notes and oversized batches are refused', async () => {
  const env = makeEnv();
  assert.equal((await call(env, '/api/sync/notes', { method: 'PUT', headers: { authorization: `Bearer ${SYNC_TOKEN}` }, body: 'not json' })).status, 400);
  assert.equal((await putNotes(env, { notes: 'x' })).status, 400);
  assert.equal((await putNotes(env, { notes: [{ path: 'big.md', body: 'é'.repeat(100_001) }] })).status, 413); // counted in bytes
  assert.equal((await putNotes(env, { notes: Array.from({ length: 501 }, (_, i) => ({ path: `n${i}.md`, body: '' })) })).status, 400);
  assert.equal((await call(env, '/api/sync/notes', { method: 'POST', headers: { authorization: `Bearer ${SYNC_TOKEN}` } })).status, 404);
});

test('keep removes notes deleted from the vault, and an empty keep never wipes the mirror', async () => {
  const env = await seeded();
  const before = Object.keys((await getHashes(env)).hashes);
  assert.equal(before.length, 7);
  let res = await putNotes(env, { notes: [], keep: [] });
  assert.equal((await res.json()).removed, 0);
  res = await putNotes(env, { notes: [{ path: 'New.md', body: 'new' }], keep: ['About Me.md'] });
  assert.deepEqual(await res.json(), { ok: true, saved: 1, removed: 6 });
  assert.deepEqual(Object.keys((await getHashes(env)).hashes).sort(), ['About Me.md', 'New.md']);
});
