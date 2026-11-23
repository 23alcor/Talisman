#!/usr/bin/env node
// Set the owner password used to approve connector apps (claude.ai, ChatGPT…) over OAuth.
//
//   npm run set-password              type a password (hidden); saved as the PASSWORD_HASH secret
//   npm run set-password -- --local   write .dev.vars for `wrangler dev` instead
//
// The first run also creates SESSION_SECRET. Changing the password signs every device out.
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline';

const LOCAL = process.argv.includes('--local');
const ITERATIONS = 100000; // the most Cloudflare Workers' PBKDF2 allows

function ask(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) process.stdout.write(s); };
    rl.question(prompt, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

const hash = (password) => {
  const salt = randomBytes(16);
  return `pbkdf2-sha256$${ITERATIONS}$${salt.toString('base64')}$${pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256').toString('base64')}`;
};

function putSecret(name, value) {
  const r = spawnSync('npx', ['wrangler', 'secret', 'put', name], { input: value, stdio: ['pipe', 'inherit', 'inherit'] });
  if (r.status !== 0) { console.error(`Could not save ${name}.`); process.exit(1); }
}

function setLocal(vars) {
  const lines = existsSync('.dev.vars') ? readFileSync('.dev.vars', 'utf8').split('\n').filter((l) => l && !Object.keys(vars).some((k) => l.startsWith(k + '='))) : [];
  for (const [k, v] of Object.entries(vars)) lines.push(`${k}=${v}`);
  writeFileSync('.dev.vars', lines.join('\n') + '\n', { mode: 0o600 });
}

const pw = await ask('New password (at least 12 characters): ');
if (pw.length < 12) { console.error('Too short. Nothing was changed.'); process.exit(1); }
if ((await ask('Again: ')) !== pw) { console.error('They did not match. Nothing was changed.'); process.exit(1); }

const vars = { PASSWORD_HASH: hash(pw) };
const hasSecret = LOCAL ? existsSync('.dev.vars') && /^SESSION_SECRET=/m.test(readFileSync('.dev.vars', 'utf8')) : false;
if (!hasSecret) vars.SESSION_SECRET = randomBytes(32).toString('base64url');
if (LOCAL) setLocal(vars);
else for (const [k, v] of Object.entries(vars)) putSecret(k, v);
console.log(LOCAL ? 'Saved to .dev.vars.' : 'Saved. Every device is signed out; sign in again to connect apps.');
