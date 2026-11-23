// A small D1 stand-in on real SQLite (node:sqlite), with the migrations applied.
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export function database() {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  // node:sqlite won't bind positional values to D1-style ?1 ?2 placeholders, so expand them in order.
  const expand = (sql, values) => {
    const ordered = [];
    const text = sql.replace(/\?(\d+)/g, (_, n) => { ordered.push(values[Number(n) - 1] ?? null); return '?'; });
    return [text, /\?\d/.test(sql) ? ordered : values];
  };
  const statement = (sql, values = []) => {
    const run = (method) => { const [text, v] = expand(sql, values); return db.prepare(text)[method](...v); };
    return {
      bind: (...v) => statement(sql, v),
      run: async () => ({ meta: { changes: Number(run('run').changes) } }),
      first: async (col) => { const row = run('get') ?? null; return col ? row?.[col] ?? null : row; },
      all: async () => ({ results: run('all') }),
      _run: () => run('run'),
    };
  };
  return {
    raw: db,
    prepare: (sql) => statement(sql),
    batch: async (stmts) => { db.exec('BEGIN'); try { const out = stmts.map((s) => s._run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } },
  };
}
