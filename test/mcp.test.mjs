import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, localNow } from '../src/config.js';
import { linksIn, noteSection } from '../src/tools.js';
import { call, makeEnv, rpc, seeded, tool } from './env.mjs';

const today = localNow('America/New_York').date;

test('the connector needs a token; without OAuth set up, everything else is refused', async () => {
  const env = makeEnv();
  assert.equal((await rpc(env, 'tools/list', {}, '')).status, 401);
  assert.equal((await rpc(env, 'tools/list', {}, env.SYNC_TOKEN)).status, 401);
  assert.equal((await call(env, '/.well-known/oauth-authorization-server')).status, 404);
  assert.equal((await call(env, '/health')).status, 200);
});

test('initialize, ping, tools/list and notifications', async () => {
  const env = makeEnv();
  const init = await rpc(env, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.body.result.protocolVersion, '2025-03-26');
  assert.equal(init.body.result.serverInfo.name, 'Talisman');
  assert.match(init.body.result.instructions, /Sam's personal context/);
  assert.deepEqual((await rpc(env, 'ping')).body.result, {});
  const names = (await rpc(env, 'tools/list')).body.result.tools.map((t) => t.name);
  assert.deepEqual(names, ['whoami', 'search_notes', 'read_note', 'list_notes', 'related_notes', 'recent_sessions']);
  assert.equal((await rpc(env, 'nope')).body.error.code, -32601);
  const note = await call(env, '/mcp', { method: 'POST', headers: { authorization: `Bearer ${env.TALISMAN_TOKEN}` }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(note.status, 202);
  const bad = await call(env, '/mcp', { method: 'POST', headers: { authorization: `Bearer ${env.TALISMAN_TOKEN}` }, body: '{' });
  assert.equal(bad.status, 400);
  assert.equal((await call(env, '/mcp', { headers: { authorization: `Bearer ${env.TALISMAN_TOKEN}` } })).status, 405);
  assert.equal((await tool(env, 'drop_tables')).error, 'Unknown tool drop_tables');
});

test('whoami: the About Me note, the time and how fresh the mirror is', async () => {
  const env = await seeded();
  const { data } = await tool(env, 'whoami');
  assert.equal(data.name, 'Sam');
  assert.equal(data.about_me_path, 'About Me.md');
  assert.match(data.about_me, /builds tools/);
  assert.equal(data.now.date, today);
  assert.equal(data.mirror.notes, 7);
  assert.ok(data.mirror.synced_at);
  const empty = (await tool(makeEnv({ OWNER_NAME: '' }), 'whoami')).data;
  assert.equal(empty.name, null);
  assert.match(empty.about_me, /No "About Me" note yet/);
  assert.equal(empty.mirror.synced_at, null);
});

test('search_notes: every word must match, title hits rank first, folder filter, LIKE wildcards are literal', async () => {
  const env = await seeded();
  const { data } = await tool(env, 'search_notes', { query: 'Lantern' });
  assert.equal(data.results[0].path, 'Projects/Lantern/Lantern.md');
  assert.ok(data.total >= 4);
  assert.equal((await tool(env, 'search_notes', { query: 'battery drain' })).data.total, 2);
  const inKiln = (await tool(env, 'search_notes', { query: 'lantern', folder: 'Projects/Kiln/' })).data;
  assert.deepEqual(inKiln.results.map((r) => r.path), ['Projects/Kiln/Kiln.md']);
  assert.match(inKiln.results[0].snippet, /Lantern/);
  const pct = (await tool(env, 'search_notes', { query: '100%' })).data; // '%' is not a word character, so this is '100'
  assert.deepEqual(pct.results.map((r) => r.path).sort(), ['Daily/' + today + '.md', 'Projects/Lantern/Lantern.md']);
  assert.equal((await tool(env, 'search_notes', { query: 'b_ttery' })).data.total, 0); // '_' is literal
  assert.match((await tool(env, 'search_notes', { query: '!!!' })).error, /at least one word/);
  assert.equal((await tool(env, 'search_notes', { query: 'session', limit: 2 })).data.results.length, 2);
});

test('read_note: by path or title, by section, in pages', async () => {
  const env = await seeded();
  assert.match((await tool(env, 'read_note', { path: 'Kiln' })).data.body, /Build runner/);
  assert.match((await tool(env, 'read_note', { path: 'projects/kiln/kiln.md' })).error ?? '', /No note/); // paths are exact
  const risks = (await tool(env, 'read_note', { path: 'Lantern', section: 'Risks' })).data;
  assert.match(risks.body, /^## Risks\n/);
  assert.match(risks.body, /Not a heading/); // headings inside code blocks don't end a section
  assert.match(risks.body, /### Detail\n\nUnder risks\./); // a deeper heading stays inside
  assert.doesNotMatch(risks.body, /## Links/);
  assert.match((await tool(env, 'read_note', { path: 'Lantern#Status' })).data.body, /Beta is out/);
  assert.match((await tool(env, 'read_note', { path: 'Lantern', section: 'Nope' })).error, /Section not found/);
  const page1 = (await tool(env, 'read_note', { path: 'Lantern', max_chars: 200 })).data;
  assert.equal(page1.body.length, 200);
  assert.equal(page1.next_offset, 200);
  const page2 = (await tool(env, 'read_note', { path: 'Lantern', offset: page1.next_offset, max_chars: 12000 })).data;
  assert.equal(page2.truncated, false);
  assert.equal(page2.next_offset, null);
  assert.match((await tool(env, 'read_note', { path: 'Lantern', max_chars: 50 })).error, /between 200 and 12000/);
  assert.match((await tool(env, 'read_note', { path: 'Nothing here' })).error, /No note/);
});

test('list_notes: newest first, with a folder filter', async () => {
  const env = await seeded();
  const all = (await tool(env, 'list_notes')).data.notes;
  assert.equal(all.length, 7);
  assert.equal(all[0].path, 'Daily/' + today + '.md');
  assert.deepEqual((await tool(env, 'list_notes', { folder: 'Projects' })).data.notes.map((n) => n.title), ['Lantern', `${addDays(today, -2)} Lantern beta`, 'Kiln']);
  assert.equal((await tool(env, 'list_notes', { limit: 2 })).data.notes.length, 2);
});

test('related_notes: outgoing links, backlinks with context, and concepts without a note', async () => {
  const env = await seeded();
  const r = (await tool(env, 'related_notes', { note: 'Lantern' })).data;
  assert.equal(r.note.path, 'Projects/Lantern/Lantern.md');
  assert.deepEqual(r.links_to, [{ title: 'Kiln', path: 'Projects/Kiln/Kiln.md' }]);
  assert.deepEqual(r.mentions_without_note, ['Offline first']); // the image embed is not a link
  const from = Object.fromEntries(r.linked_from.map((x) => [x.path, x.context]));
  assert.deepEqual(Object.keys(from).sort(), ['About Me.md', 'Daily/' + today + '.md', 'Projects/Kiln/Kiln.md', `Projects/Lantern/Sessions/${addDays(today, -2)} Lantern beta.md`].sort());
  assert.equal(from['About Me.md'], 'Ship [[Lantern]] by spring.');
  assert.match(from['Projects/Kiln/Kiln.md'], /\[\[Lantern#Status\]\]/);
  const concept = (await tool(env, 'related_notes', { note: 'Offline first' })).data;
  assert.equal(concept.note.has_own_note, false);
  assert.deepEqual(concept.linked_from.map((x) => x.path), ['Projects/Lantern/Lantern.md']);
});

test('recent_sessions: session notes in the window, newest first, by project', async () => {
  const env = await seeded();
  const s = (await tool(env, 'recent_sessions')).data;
  assert.equal(s.since, addDays(today, -7));
  assert.deepEqual(s.sessions.map((x) => x.title), [`${addDays(today, -2)} Lantern beta`, `${addDays(today, -3)} Kiln cache`]);
  assert.equal(s.sessions[0].summary, 'Shipped the beta build.');
  assert.equal(s.sessions[0].next_steps, '- Fix battery drain');
  assert.equal(s.sessions[1].next_steps, 'Cache eviction.');
  assert.equal((await tool(env, 'recent_sessions', { days: 30 })).data.sessions.length, 3);
  assert.deepEqual((await tool(env, 'recent_sessions', { project: 'Kiln' })).data.sessions.map((x) => x.title), [`${addDays(today, -3)} Kiln cache`]);
  assert.deepEqual((await tool(env, 'recent_sessions', { project: '[[Lantern]]' })).data.sessions.map((x) => x.title), [`${addDays(today, -2)} Lantern beta`]);
  const custom = await seeded({ SESSIONS_FOLDER: 'Logs' });
  assert.equal((await tool(custom, 'recent_sessions')).data.sessions.length, 0);
});

test('link parsing and sections', () => {
  assert.deepEqual(linksIn('[[A]] [[B|b]] [[C#h]] [[D/E]] ![[pic.png]] ![[Embedded note]] [[A]]'), ['A', 'B', 'C', 'D/E', 'Embedded note']);
  assert.equal(noteSection('# T\n## A\none\n## B\ntwo', 'B'), '## B\ntwo');
  assert.throws(() => noteSection('x', 'y'.repeat(201)));
});
