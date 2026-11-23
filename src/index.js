// Talisman Worker: the connector (/mcp), its sign-in for connector apps, and the read mirror's sync API.
//
//   /mcp                   MCP server. Bearer TALISMAN_TOKEN (Claude Code, Codex, Cursor…) or OAuth (claude.ai, ChatGPT…)
//   /authorize, /oauth/*   OAuth for connector apps; approving = signing in with the owner password and clicking Allow
//   /login, /logout        owner sign-in (only needed for OAuth)
//   /api/sync/notes        read mirror updates from the sync client (bearer SYNC_TOKEN)
//   /health                liveness check
import { AuthorizationError, CimdFetchError, OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { config } from './config.js';
import { mcp } from './mcp.js';
import { syncNotes } from './sync.js';
import {
  authConfigured, bearer, checkPassword, clearFailures, consentPage, lockedOut, loginPage, recordFailure,
  safeNext, sameText, sessionCookie, signedIn, statusPage,
} from './auth.js';

const SECURITY_HEADERS = {
  // same-origin, not no-referrer: with no-referrer, browsers send `Origin: null` on our own form posts.
  'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY',
  // No form-action: Chrome applies it to the redirect after the consent form, which goes to the AI app's own site.
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
};
const secure = (res) => { const r = new Response(res.body, res); for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v); return r; };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const html = (markup, status = 200, extra = {}) => secure(new Response(markup, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra } }));
const redirect = (location, extra = {}) => secure(new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store', ...extra } }));
// Form posts must come from our own pages. Browsers send Sec-Fetch-Site, which pages can't fake; without it
// (older browsers, scripts) fall back to Origin, where a missing Origin is allowed and `null` is not.
function crossSite(req, url) {
  const site = req.headers.get('sec-fetch-site');
  if (site) return site !== 'same-origin' && site !== 'none';
  const o = req.headers.get('origin');
  return Boolean(o) && o !== url.origin;
}
const clientIp = (req) => req.headers.get('cf-connecting-ip') || 'unknown';

export const OAUTH_PATH = /^\/(mcp|authorize|oauth\/(token|register)|\.well-known\/oauth-[\w-]+(\/mcp)?)$/;

// The OAuth consent flow. Runs as the provider's default handler, so env.OAUTH_PROVIDER is available.
const authorize = {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== '/authorize') return secure(json({ error: 'not found' }, 404));
    if (!authConfigured(env)) return html(statusPage(false), 503);
    if (!(await signedIn(req, env))) return redirect('/login?next=' + encodeURIComponent(url.pathname + url.search));
    const oauth = env.OAUTH_PROVIDER;
    try {
      if (req.method === 'GET') {
        const request = await oauth.parseAuthRequest(req);
        const details = await oauth.describeConsent(request);
        const consent = await oauth.beginConsent(request);
        consent.headers.set('content-type', 'text/html; charset=utf-8');
        return secure(new Response(consentPage(details, consent.handle), { headers: consent.headers }));
      }
      if (req.method !== 'POST') return new Response(null, { status: 405 });
      if (crossSite(req, url)) return secure(json({ error: 'forbidden' }, 403));
      const form = await req.formData();
      const handle = String(form.get('handle') || '');
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(req, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(req, handle, { scope: ['mcp'] });
      const { redirectTo } = await oauth.completeAuthorization({ request: approved.request, userId: 'owner', metadata: {}, scope: ['mcp'], props: {} });
      approved.headers.set('location', redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    } catch (e) {
      if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
      if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
        const msg = e instanceof AuthorizationError ? e.description || 'This request expired. Start connecting again.' : 'This app could not be verified.';
        return secure(new Response(msg, { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } }));
      }
      throw e;
    }
  },
};

const providers = new Map(); // one per origin: the resource URL is part of the provider's config
function oauthProvider(origin) {
  if (!providers.has(origin)) {
    providers.set(origin, new OAuthProvider({
      apiRoute: '/mcp',
      apiHandler: { fetch: async (req, env) => secure(await mcp(req, env, config(env))) },
      defaultHandler: authorize,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: ['mcp'],
      resourceMetadata: { resource: origin + '/mcp', authorization_servers: [origin] },
      clientIdMetadataDocumentEnabled: true, // needs the global_fetch_strictly_public compatibility flag
    }));
  }
  return providers.get(origin);
}

async function login(req, env, url) {
  if (crossSite(req, url)) return secure(json({ error: 'forbidden' }, 403));
  if (!authConfigured(env)) return html(statusPage(false), 503);
  const form = await req.formData().catch(() => null);
  const next = safeNext(String(form?.get('next') || '/'));
  const ip = clientIp(req);
  if (await lockedOut(env, ip)) return html(loginPage({ error: 'Too many tries. Wait 15 minutes and try again.', next }), 429);
  if (!(await checkPassword(String(form?.get('password') || ''), env.PASSWORD_HASH))) {
    await recordFailure(env, ip);
    return html(loginPage({ error: 'That password is not right.', next }), 401);
  }
  await clearFailures(env, ip);
  return redirect(next, { 'set-cookie': await sessionCookie(env) });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/health') return secure(json({ ok: true, service: 'talisman' }));
      if (url.pathname === '/api/sync/notes') {
        if (!env.SYNC_TOKEN || !sameText(bearer(req), env.SYNC_TOKEN)) return secure(json({ error: 'unauthorized' }, 401));
        return secure(await syncNotes(req, env));
      }
      if (OAUTH_PATH.test(url.pathname)) {
        if (url.pathname === '/mcp' && env.TALISMAN_TOKEN && sameText(bearer(req), env.TALISMAN_TOKEN)) return secure(await mcp(req, env, config(env)));
        if (!env.OAUTH_KV) return secure(json({ error: url.pathname === '/mcp' ? 'unauthorized' : 'not found' }, url.pathname === '/mcp' ? 401 : 404));
        return await oauthProvider(url.origin).fetch(req, env, ctx);
      }
      if (url.pathname === '/login') {
        if (req.method === 'POST') return await login(req, env, url);
        if (await signedIn(req, env)) return redirect(safeNext(url.searchParams.get('next')));
        return html(loginPage({ next: safeNext(url.searchParams.get('next')) }));
      }
      if (url.pathname === '/logout' && req.method === 'POST') {
        if (crossSite(req, url)) return secure(json({ error: 'forbidden' }, 403));
        return redirect('/login', { 'set-cookie': 'talisman_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' });
      }
      if (url.pathname === '/' && req.method === 'GET') return html(statusPage(authConfigured(env)));
      return secure(json({ error: 'not found' }, 404));
    } catch (e) {
      console.error('request failed', url.pathname, e);
      return secure(json({ error: 'server error' }, 500));
    }
  },
};
