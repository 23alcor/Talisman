import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { checkPassword, safeNext } from '../src/auth.js';
import { ORIGIN, PASSWORD, call, kv, makeEnv, passwordHash, rpc, seeded } from './env.mjs';

// A tiny cookie jar: keeps name=value pairs from Set-Cookie, sends them back.
function jar() {
  const c = new Map();
  return {
    take(res) { for (const s of res.headers.getSetCookie()) { const [pair, ...attrs] = s.split(';'); const [k, v] = pair.split('='); if (attrs.some((a) => /max-age=0/i.test(a.trim()))) c.delete(k.trim()); else c.set(k.trim(), v); } return res; },
    get header() { return [...c].map(([k, v]) => `${k}=${v}`).join('; '); },
    has: (k) => c.has(k),
  };
}
const form = (o) => new URLSearchParams(o);

async function signIn(env, cookies, next = '/') {
  const res = cookies.take(await call(env, '/login', { method: 'POST', headers: { origin: ORIGIN }, body: form({ password: PASSWORD, next }) }));
  assert.equal(res.status, 303);
  return res;
}

test('password hashes check out, and wrong or malformed ones fail', async () => {
  const h = passwordHash('s3cret pass');
  assert.equal(await checkPassword('s3cret pass', h), true);
  assert.equal(await checkPassword('s3cret pas', h), false);
  assert.equal(await checkPassword('', h), false);
  assert.equal(await checkPassword('x', 'sha1$1$a$b'), false);
  assert.equal(await checkPassword('x', undefined), false);
});

test('safeNext only allows same-site paths', () => {
  for (const ok of ['/', '/authorize?x=1']) assert.equal(safeNext(ok), ok);
  for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', 'authorize', '/login?next=/', '/\t/evil.example', '/\n/evil.example', '/\r\n/evil.example', undefined]) assert.equal(safeNext(bad), '/');
});

test('sign-in: right password sets a session cookie, wrong ones are counted and locked out', async () => {
  const env = makeEnv();
  const cookies = jar();
  const wrong = await call(env, '/login', { method: 'POST', body: form({ password: 'nope', next: '/x' }) });
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /not right/);
  const res = await signIn(env, cookies, '/authorize?a=1');
  assert.equal(res.headers.get('location'), '/authorize?a=1');
  assert.ok(cookies.has('talisman_session'));
  assert.match(res.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  // a signed-in visit to /login goes straight on
  assert.equal((await call(env, '/login?next=/y', { headers: { cookie: cookies.header } })).headers.get('location'), '/y');
  // a tampered cookie is not a session
  const forged = cookies.header.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  assert.equal((await call(env, '/login', { headers: { cookie: forged } })).status, 200);
  // changing the password signs every device out
  const env2 = { ...env, PASSWORD_HASH: passwordHash(PASSWORD) };
  assert.equal((await call(env2, '/login', { headers: { cookie: cookies.header } })).status, 200);
  for (let i = 0; i < 8; i++) await call(env, '/login', { method: 'POST', body: form({ password: 'nope' }) }); // the sign-in above cleared the first one
  const locked = await call(env, '/login', { method: 'POST', body: form({ password: PASSWORD }) });
  assert.equal(locked.status, 429); // 8 failures, even the right password waits
  assert.equal((await call(env, '/login', { method: 'POST', headers: { origin: 'https://evil.example' }, body: form({ password: PASSWORD }) })).status, 403);
  assert.equal((await call(makeEnv({ PASSWORD_HASH: '' }), '/login', { method: 'POST', body: form({ password: PASSWORD }) })).status, 503);
});

test('form posts from our own pages work the way real browsers send them; cross-site ones are refused', async () => {
  const env = makeEnv();
  const post = (headers) => call(env, '/login', { method: 'POST', headers, body: form({ password: PASSWORD, next: '/' }) });
  // A browser on a page with a strict referrer policy sends Origin: null, but Sec-Fetch-Site still says same-origin.
  assert.equal((await post({ origin: 'null', 'sec-fetch-site': 'same-origin' })).status, 303);
  assert.equal((await post({ origin: ORIGIN, 'sec-fetch-site': 'same-origin' })).status, 303);
  assert.equal((await post({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post({ origin: 'https://sub.talisman.test', 'sec-fetch-site': 'same-site' })).status, 403);
  assert.equal((await post({ origin: 'null' })).status, 403); // no Sec-Fetch-Site: a null origin isn't trusted
  const page = await call(env, '/login');
  assert.equal(page.headers.get('referrer-policy'), 'same-origin'); // so browsers send our real origin on form posts
});

test('OAuth: register, sign in, approve, swap the code for a token, then use the connector', async () => {
  const env = await seeded({ OAUTH_KV: kv() });
  const meta = await (await call(env, '/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(meta.resource, ORIGIN + '/mcp');
  const unauth = await rpc(env, 'tools/list', {}, '');
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate') || '', /resource_metadata=/);

  const reg = await call(env, '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://app.example/callback'], client_name: 'Test <b>App</b>', token_endpoint_auth_method: 'none' }) });
  assert.equal(reg.status, 201);
  const { client_id } = await reg.json();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorizeUrl = '/authorize?' + form({ response_type: 'code', client_id, redirect_uri: 'https://app.example/callback', code_challenge: challenge, code_challenge_method: 'S256', state: 'st8', scope: 'mcp' });

  const cookies = jar();
  const toLogin = await call(env, authorizeUrl);
  assert.equal(toLogin.status, 303);
  assert.equal(toLogin.headers.get('location'), '/login?next=' + encodeURIComponent(authorizeUrl));
  await signIn(env, cookies, authorizeUrl);

  const consent = cookies.take(await call(env, authorizeUrl, { headers: { cookie: cookies.header } }));
  assert.equal(consent.status, 200);
  const page = await consent.text();
  assert.match(page, /Allow Test &lt;b&gt;App&lt;\/b&gt; to read your notes\?/); // client-supplied names are escaped
  assert.match(consent.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const handle = page.match(/name="handle" value="([^"]+)"/)[1].replace(/&amp;/g, '&');

  assert.equal((await call(env, '/authorize', { method: 'POST', headers: { cookie: cookies.header, origin: 'https://evil.example' }, body: form({ handle, decision: 'approve' }) })).status, 403);
  const approved = await call(env, '/authorize', { method: 'POST', headers: { cookie: cookies.header, origin: ORIGIN }, body: form({ handle, decision: 'approve' }) });
  assert.equal(approved.status, 302);
  const back = new URL(approved.headers.get('location'));
  assert.equal(back.origin + back.pathname, 'https://app.example/callback');
  assert.equal(back.searchParams.get('state'), 'st8');

  const tok = await call(env, '/oauth/token', { method: 'POST', body: form({ grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: 'https://app.example/callback', client_id, code_verifier: verifier }) });
  assert.equal(tok.status, 200);
  const { access_token } = await tok.json();
  const listed = await rpc(env, 'tools/list', {}, access_token);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.result.tools.length, 9);
  const who = await rpc(env, 'tools/call', { name: 'whoami', arguments: {} }, access_token);
  assert.equal(JSON.parse(who.body.result.content[0].text).name, 'Sam');
});

test('OAuth: denying sends the app an access_denied error', async () => {
  const env = makeEnv({ OAUTH_KV: kv() });
  const { client_id } = await (await call(env, '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://app.example/cb'], client_name: 'Other', token_endpoint_auth_method: 'none' }) })).json();
  const url = '/authorize?' + form({ response_type: 'code', client_id, redirect_uri: 'https://app.example/cb', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', state: 's' });
  const cookies = jar();
  await signIn(env, cookies);
  const consent = cookies.take(await call(env, url, { headers: { cookie: cookies.header } }));
  const handle = (await consent.text()).match(/name="handle" value="([^"]+)"/)[1].replace(/&amp;/g, '&');
  const denied = await call(env, '/authorize', { method: 'POST', headers: { cookie: cookies.header }, body: form({ handle, decision: 'deny' }) });
  assert.equal(denied.status, 302);
  assert.equal(new URL(denied.headers.get('location')).searchParams.get('error'), 'access_denied');
});
