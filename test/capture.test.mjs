import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { captureTargets, summarizeDue } from '../src/capture.js';
import { config } from '../src/config.js';
import { SYNC_TOKEN, call, putNotes, seeded } from './env.mjs';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// A stand-in for the model provider's Responses API that records what it was asked.
function fakeModel(reply = {}, { status = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers.authorization });
    const out = { title: 'Ship the lamp beta', kind: 'work', category: 'coding', target: 'Lantern', summary: 'Shipped the beta build.',
      changed: ['Built the beta'], decisions: ['Ship Friday'], next: ['Fix battery drain'], covered: [], key_ideas: [], unclear: [],
      review: [], links: ['https://github.com/x/lamp'], concepts: ['Battery life'], ...reply };
    return new Response(JSON.stringify(status === 200 ? { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(out) }] }] }
      : { error: { message: 'nope' } }), { status });
  };
  return calls;
}

const KEYED = { OPENAI_API_KEY: 'test-key', SUMMARY_MODEL: 'test-model' };
const chat = (n = 1) => 'Tool: claude-code\nWorking directory: /home/sam/lamp\n\n' + Array.from({ length: n }, (_, i) => `User: step ${i}\n\nAssistant: did step ${i}`).join('\n\n');
const send = async (env, body, token = env.TALISMAN_TOKEN) => {
  const res = await call(env, '/api/capture', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ capture_id: 'cap1234567890', source: 'claude-code', cwd: '/home/sam/lamp', started_at: '2026-11-23T14:00:00Z', ...body }) });
  return { status: res.status, body: await res.json() };
};
const capture = (env) => env.DB.prepare('SELECT * FROM captures').first();
const writes = async (env) => (await env.DB.prepare('SELECT * FROM writes ORDER BY seq').all()).results.map((w) => ({ ...w, payload: JSON.parse(w.payload) }));
const due = (env) => env.DB.raw.prepare('UPDATE captures SET quiet_until = 0').run();

test('only the connector token can send captures', async () => {
  const env = await seeded(KEYED);
  assert.equal((await send(env, { transcript: chat() }, SYNC_TOKEN)).status, 401);
  assert.equal((await send(env, { transcript: chat() }, 'nope')).status, 401);
  assert.equal((await send(env, { transcript: chat(), capture_id: 'x' })).status, 400);
  assert.equal((await send(env, { transcript: '  ' })).status, 400);
  assert.equal((await send(env, { transcript: 'x'.repeat(1_500_001) })).status, 413);
});

test('one record per chat: it grows in place, and repeats or late copies change nothing', async () => {
  const env = await seeded(KEYED);
  const first = (await send(env, { transcript: chat(1) })).body;
  assert.equal(first.revision, 1);
  assert.ok(Date.parse(first.summarize_after) > Date.now() + 9 * 60e3); // waits 10 quiet minutes
  assert.equal((await send(env, { transcript: chat(1) })).body.changed, false);
  assert.equal((await send(env, { transcript: chat(3) })).body.revision, 2);
  assert.equal((await send(env, { transcript: chat(2) })).body.changed, false); // an older copy arriving late
  const c = await capture(env);
  assert.equal(c.transcript, chat(3));
  assert.equal(c.started_at, '2026-11-23T14:00:00.000Z');
});

test('a quiet chat is summarized into a session write, with its project matched and its transcript linked', async () => {
  const env = await seeded(KEYED);
  await putNotes(env, { notes: [{ path: 'Projects/Lantern/Lantern.md', title: 'Lantern', body: '---\ntype: project\naliases: [lamp app]\n---\n# Lantern\nA reading lamp app.' }] });
  const calls = fakeModel();
  await send(env, { transcript: chat(2) });
  assert.equal((await summarizeDue(env, config(env))).summarized, 0); // still inside the quiet period
  await due(env);
  assert.equal((await summarizeDue(env, config(env))).summarized, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, 'test-model');
  assert.equal(calls[0].auth, 'Bearer test-key');
  assert.match(calls[0].body.instructions, /- Lantern · project · lamp app; A reading lamp app\./);
  assert.match(calls[0].body.input[0].content, /Working directory: \/home\/sam\/lamp[\s\S]*TRANSCRIPT:\nTool: claude-code/);
  const [w] = await writes(env);
  assert.equal(w.key, 'session:cap_cap1234567890');
  assert.equal(w.payload.project, 'Lantern');
  assert.equal(w.payload.transcript_capture, 'cap1234567890');
  assert.deepEqual([w.payload.date, w.payload.start], ['2026-11-23', '09:00']); // in the owner's time zone
  assert.deepEqual(w.payload.changes, ['Built the beta']);
  assert.deepEqual(w.payload.concepts, ['Battery life']);
  assert.equal((await capture(env)).status, 'done');
  assert.equal((await summarizeDue(env, config(env))).summarized, 0); // nothing new
});

test('as the chat grows the same session note is updated; when it ends it is due at once', async () => {
  const env = await seeded(KEYED);
  fakeModel({ target: 'Nope', kind: 'study', covered: ['Kirchhoff'], review: ['Ch. 3'] });
  await send(env, { transcript: chat(1) });
  await due(env);
  await summarizeDue(env, config(env));
  const ended = (await send(env, { transcript: chat(4), final: true })).body; // ended: no quiet period
  assert.ok(Date.parse(ended.summarize_after) <= Date.now());
  assert.equal((await writes(env)).length, 1); // summarized by the next cron run, not inside the request
  await summarizeDue(env, config(env));
  const ws = await writes(env);
  assert.deepEqual(ws.map((w) => [w.key, w.revision, w.status]), [['session:cap_cap1234567890', 1, 'superseded'], ['session:cap_cap1234567890', 2, 'queued']]);
  assert.equal(ws[1].payload.project, ''); // the model's guess wasn't a real target
  assert.deepEqual([ws[1].payload.kind, ws[1].payload.changes, ws[1].payload.next_steps], ['study', ['Kirchhoff'], ['Ch. 3']]);
  assert.equal((await capture(env)).final, 1);
});

test('model failures are retried later, then given up on until the chat grows again', async () => {
  const env = await seeded(KEYED);
  fakeModel({}, { status: 500 });
  await send(env, { transcript: chat(1) });
  for (let i = 0; i < 3; i++) { await due(env); await summarizeDue(env, config(env)); }
  let c = await capture(env);
  assert.equal(c.status, 'error');
  assert.match(c.error, /Model error 500/);
  await due(env);
  assert.equal((await summarizeDue(env, config(env))).summarized, 0);
  fakeModel();
  await send(env, { transcript: chat(2) });
  await due(env);
  assert.equal((await summarizeDue(env, config(env))).summarized, 1);
  assert.equal((await capture(env)).status, 'done');
});

test('without an API key nothing is summarized, and secrets in a summary are blanked', async () => {
  const env = await seeded();
  fakeModel();
  await send(env, { transcript: chat(1), final: true });
  assert.equal((await capture(env)).status, 'waiting');
  assert.equal((await summarizeDue(env, config(env))).summarized, 0);
  const keyed = await seeded(KEYED);
  fakeModel({ next: ['rotate sk-abcdefghijklmnopqrstuvwxyz123456'] });
  await send(keyed, { transcript: chat(1), final: true });
  await summarizeDue(keyed, config(keyed));
  const [w] = await writes(keyed);
  assert.deepEqual(w.payload.next_steps, ['rotate [REDACTED]']);
});

test('the applier fetches a captured transcript with the sync token', async () => {
  const env = await seeded(KEYED);
  await send(env, { transcript: chat(2) });
  const get = (id, token = SYNC_TOKEN) => call(env, '/api/applier/transcript/' + id, { headers: { authorization: `Bearer ${token}` } });
  const ok = await get('cap1234567890');
  assert.equal(ok.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await ok.text(), chat(2));
  assert.equal((await get('cap0000000000')).status, 404);
  assert.equal((await get('cap1234567890', env.TALISMAN_TOKEN)).status, 401);
});

test('the cron trigger sweeps quiet chats, and targets come from project, course and area notes', async () => {
  const env = await seeded(KEYED);
  await putNotes(env, { notes: [
    { path: 'C/EECE 448.md', title: 'EECE 448', body: '---\ntype: course\ncode: EECE 448\n---\n# ML\nApplied machine learning.' },
    { path: 'A/Health.md', title: 'Health', body: '---\ntype: area\n---\nGym and food.' },
    { path: 'N/Random.md', title: 'Random', body: '---\ntype: note\n---\nnot a target' },
  ] });
  assert.deepEqual((await captureTargets(env)).map((t) => [t.name, t.kind, t.hint]).sort(),
    [['EECE 448', 'course', 'EECE 448; Applied machine learning.'], ['Health', 'area', 'Gym and food.']].sort()); // headings skipped
  fakeModel();
  await send(env, { transcript: chat(1) });
  await due(env);
  const waits = [];
  await worker.scheduled({ cron: '*/5 * * * *' }, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.equal((await writes(env)).length, 1);
});
