// Lets the tests load the Worker in plain Node: Node has no `cloudflare:workers` module.
import { register } from 'node:module';

const hooks = `
export async function resolve(spec, ctx, next) {
  if (spec === 'cloudflare:workers') return { url: 'data:text/javascript,export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class DurableObject {}', shortCircuit: true };
  return next(spec, ctx);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));
