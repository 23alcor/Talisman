// Per-install settings from `vars` in wrangler.jsonc. Nothing personal is hardcoded in the code.
const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
const val = (env, key, fallback, max = 120) => (typeof env[key] === 'string' && env[key].trim() ? env[key].trim().slice(0, max) : fallback);

export function config(env = {}) {
  const tz = val(env, 'TIMEZONE', 'UTC', 60);
  return {
    owner: val(env, 'OWNER_NAME', '', 40),
    tz: validTz(tz) ? tz : 'UTC',
    aboutNote: val(env, 'ABOUT_NOTE', 'About Me', 120),
    sessionsFolder: val(env, 'SESSIONS_FOLDER', 'Sessions', 200).replace(/^\/+|\/+$/g, ''),
  };
}

// 'YYYY-MM-DD', 'HH:MM' and the weekday in the owner's time zone.
export function localNow(tz, d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'long', hour12: false }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t)?.value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`, weekday: g('weekday') };
}

export function addDays(date, n) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
