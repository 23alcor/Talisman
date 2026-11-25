// Owner sign-in for connecting AI apps over OAuth: PBKDF2 password check, HMAC-signed session cookie,
// per-IP lockout, and the sign-in and consent pages.
//
// Secrets (set with `npm run set-password`, never committed):
//   PASSWORD_HASH   pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>
//   SESSION_SECRET  random string used to sign session cookies
const enc = new TextEncoder();
const COOKIE = 'talisman_session';
const SESSION_DAYS = 30;
const MAX_FAILS = 8; // wrong passwords per IP per window
const WINDOW_MS = 15 * 60e3;

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function sameText(a, b) {
  const x = enc.encode(String(a ?? '')), y = enc.encode(String(b ?? ''));
  if (!x.length || x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

export const bearer = (req) => (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');

export async function checkPassword(password, stored) {
  const [alg, iter, salt, hash] = String(stored || '').split('$');
  if (alg !== 'pbkdf2-sha256' || !iter || !salt || !hash || !password) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const expected = fromB64(hash);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(salt), iterations: Number(iter) }, key, expected.length * 8));
  let d = bits.length ^ expected.length;
  for (let i = 0; i < Math.min(bits.length, expected.length); i++) d |= bits[i] ^ expected[i];
  return d === 0;
}

export const authConfigured = (env) => Boolean(env.PASSWORD_HASH && env.SESSION_SECRET);

// Signing over the password hash means changing the password signs every device out.
async function sign(env, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(`${msg}.${env.PASSWORD_HASH}`)));
}

export async function sessionCookie(env) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(12)));
  return `${COOKIE}=${exp}.${nonce}.${await sign(env, `${exp}.${nonce}`)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
}

export async function signedIn(req, env) {
  if (!authConfigured(env)) return false;
  const m = (req.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, nonce, sig] = m[1].split('.');
  if (!exp || !nonce || !sig || !(Number(exp) > Date.now() / 1000)) return false;
  return sameText(await sign(env, `${exp}.${nonce}`), sig);
}

export async function lockedOut(env, ip) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_failures WHERE ip = ?1 AND at > ?2').bind(ip, Date.now() - WINDOW_MS).first();
  return (r?.n || 0) >= MAX_FAILS;
}
export async function recordFailure(env, ip) {
  await env.DB.batch([
    env.DB.prepare('INSERT INTO auth_failures (ip, at) VALUES (?1, ?2)').bind(ip, Date.now()),
    env.DB.prepare('DELETE FROM auth_failures WHERE at < ?1').bind(Date.now() - 86400e3),
  ]);
}
export const clearFailures = (env, ip) => env.DB.prepare('DELETE FROM auth_failures WHERE ip = ?1').bind(ip).run();

// Only same-site relative paths, so the sign-in form can't be used as an open redirect. Control characters are
// refused because browsers strip tabs and newlines from URLs, which would turn '/\t/evil.example' into '//evil.example'.
export const safeNext = (next) => (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')
  && !next.startsWith('/login') && !/[\x00-\x1f\x7f]/.test(next) ? next : '/');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, inner) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Talisman · ${esc(title)}</title><meta name="robots" content="noindex">
<style>
:root{--bg:#F4F4F5;--card:#FFF;--ink:#16171A;--muted:#5C5F66;--line:#DADBDF;--err:#B42318}
@media (prefers-color-scheme:dark){:root{--bg:#0F1012;--card:#17181B;--ink:#E6E6E8;--muted:#A6A9B0;--line:#2A2B30;--err:#FF8A80}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,sans-serif;padding:16px}
main{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px 24px}
h1{font-size:20px;margin:0 0 18px}
label{display:block;font-size:14px;color:var(--muted);margin:0 0 6px}
input{width:100%;min-height:44px;padding:0 12px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--ink);font:inherit}
input:focus{outline:2px solid var(--ink);outline-offset:1px}
button{margin-top:16px;width:100%;min-height:44px;border:0;border-radius:10px;background:var(--ink);color:var(--card);font:inherit;font-weight:600;cursor:pointer}
button.secondary{background:transparent;color:var(--ink);border:1px solid var(--line)}
p{margin:0 0 10px;font-size:15px}.muted{color:var(--muted)}.err{color:var(--err);font-size:14px;margin:10px 0 0}
</style></head><body><main><h1>Talisman</h1>${inner}</main></body></html>`;
}

export function loginPage({ error = '', next = '/' } = {}) {
  return page('sign in', `<form method="post" action="/login">
<input type="hidden" name="next" value="${esc(next)}">
<label for="pw">Password</label>
<input id="pw" type="password" name="password" autocomplete="current-password" required autofocus>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
<button type="submit">Sign in</button>
</form>`);
}

// OAuth consent (/authorize): an AI app asks to read the owner's notes. Every client-supplied string is escaped.
export function consentPage(d, handle) {
  const who = d.clientDomain ? `Published by <strong>${esc(d.clientDomain)}</strong>.` : 'This app registered itself, so its name is not verified.';
  return page('connect an app', `<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${esc(handle)}">
<p style="font-size:18px;font-weight:600">Allow ${esc(d.clientName || 'this app')} to read your notes?</p>
<p class="muted">${who} Access goes to <strong>${esc(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? '<p class="err">This sends access to an app on this computer. Continue only if you just started connecting from it.</p>' : ''}
<p>It will be able to search and read the notes in your Talisman mirror. It can't edit or delete anything.</p>
<button type="submit" name="decision" value="approve">Allow</button>
<button type="submit" name="decision" value="deny" class="secondary">Deny</button>
</form>`);
}

export const statusPage = (configured) => page('status', configured
  ? '<p>This Talisman is running. Connect an AI app to <code>/mcp</code>.</p>'
  : '<p>This Talisman is running, but sign-in isn\'t set up yet. Run <code>npm run set-password</code>.</p>');
