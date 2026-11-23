// The connector: an MCP server (Model Context Protocol) at /mcp, so any AI client can read the owner's context.
// Stateless Streamable HTTP: each POST is one JSON-RPC message, answered as JSON. Auth is checked in index.js.
import { READ_TOOLS, ToolError, readTools } from './tools.js';

const VERSION = '0.1.0';
const MAX_RESULT = 24000; // characters per tool result, so one call can't flood a model's context

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const rpc = (id, result) => json({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message, status = 200) => json({ jsonrpc: '2.0', id, error: { code, message } }, status);

export const TOOLS = READ_TOOLS;

const instructions = (cfg) => [
  `This server is Talisman: ${cfg.owner ? cfg.owner + "'s" : 'the owner\'s'} personal context, read from their notes vault.`,
  'Call whoami when personal background matters and use it to tailor answers. Look things up (search_notes, recent_sessions) before asking them something their notes might answer.',
  'related_notes follows links from a note to connected projects, sessions and ideas. Use read_note with section, offset and max_chars instead of reading whole long notes.',
  'Results come from a mirror of the vault; whoami reports when it was last synced.',
].join(' ');

export async function mcp(req, env, cfg) {
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  let msg;
  try { msg = await req.json(); } catch { return rpcError(null, -32700, 'Parse error', 400); }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') return rpcError(null, -32600, 'Invalid request', 400);
  if (msg.id === undefined || msg.id === null) return new Response(null, { status: 202 }); // notifications and responses
  const p = msg.params || {};
  switch (msg.method) {
    case 'initialize':
      // This server only uses tools, which every protocol version shares, so it accepts the client's version.
      return rpc(msg.id, {
        protocolVersion: typeof p.protocolVersion === 'string' ? p.protocolVersion : '2025-06-18',
        capabilities: { tools: {} }, serverInfo: { name: 'Talisman', version: VERSION }, instructions: instructions(cfg),
      });
    case 'ping': return rpc(msg.id, {});
    case 'tools/list': return rpc(msg.id, { tools: TOOLS });
    case 'tools/call': {
      let text, isError = false;
      try {
        const name = String(p.name || '');
        const handlers = readTools(env, cfg);
        if (!TOOLS.some((t) => t.name === name) || !handlers[name]) throw new ToolError(`Unknown tool ${name}`);
        const args = p.arguments && typeof p.arguments === 'object' && !Array.isArray(p.arguments) ? p.arguments : {};
        text = JSON.stringify(await handlers[name](args));
      } catch (e) {
        if (!(e instanceof ToolError)) console.error('tool failed', p.name, e);
        text = e instanceof ToolError ? e.message : 'That failed on the server.';
        isError = true;
      }
      if (text.length > MAX_RESULT) text = JSON.stringify({ truncated: true, message: 'Result is too large. Ask for fewer results or a smaller section of the note.' });
      return rpc(msg.id, { content: [{ type: 'text', text }], ...(isError ? { isError } : {}) });
    }
    default: return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}
