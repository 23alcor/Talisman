# Talisman

**Explain your work once. Every AI gets it.**

Talisman is a context manager for AI. Your notes are a plain Markdown vault (Obsidian-compatible) and stay the source of truth. Every AI you use — Claude, ChatGPT, Grok, Claude Code, Codex, Cursor, on any device — reads the same context through one connector, and writes back through one safe path.

> **Status: early.** Step 1 works: a self-hosted connector and read mirror on Cloudflare's free plan (see [Set up](#set-up)). AIs can read your notes; writing back (the queue and applier) is step 2.

## The problem

Every AI tool starts cold. You re-explain your projects in each chat, keep `CLAUDE.md`, `AGENTS.md` and custom instructions in sync by hand, and lose what each session decided the moment it ends. Notes apps hold the knowledge, but AIs can't safely read them from your phone, and letting several agents edit the same files at once is asking for trouble.

## How it works

```mermaid
flowchart LR
    AI["Any AI<br/>(phone, web, terminal)"]
    subgraph Cloud["Talisman cloud (always on)"]
        R["Reads<br/>notes mirror"]
        Q["Write queue"]
    end
    subgraph Home["Your always-on machine"]
        A["Applier"]
        V["Vault<br/>(Markdown files)"]
    end
    D["Your other devices<br/>(view only)"]
    AI --> R
    AI --> Q
    Q --> A --> V
    V -- mirror --> R
    V -- sync --> D
```

- **The vault is the graph.** Notes are Markdown files and `[[links]]` are the edges. There is no separate database to lose: every copy of the vault carries the whole graph.
- **Reads are always available.** A searchable mirror of the vault lives in the cloud, so any AI can get context even when your computers are off.
- **One writer.** AIs never touch your files directly. Every write (a session summary, a handoff, a new note) goes into a queue, and a single applier on your always-on machine writes it into the vault, in order.
- **Nothing is lost, and nobody is fooled.** If the applier's machine is offline, writes wait in the queue and the AI is told so in its reply: writing is paused, reading still works.
- **Sessions capture themselves.** Hooks for coding agents send each conversation in as it grows, one record per conversation, summarized once it goes quiet and filed into the vault. Chat apps without hooks save sessions through a tool call.
- **Your notes stay yours.** No AI tool can edit or delete a note you wrote. Secrets are never stored.

## Pieces

| Piece | Job |
|---|---|
| Connector (MCP) | Context tools for any AI: who you are, search, read, follow links, recent sessions, resume a project or task, save a handoff, log a session |
| Read mirror | Always-on copy of the vault that the connector reads |
| Write queue | Ordered, versioned writes waiting to be applied; tells AIs when writing is paused |
| Applier | Runs on your always-on machine: applies queued writes, refreshes the mirror, checks in so Talisman knows it's alive |
| Capture | Hooks that send coding-agent conversations in as they grow |
| Backup (optional) | Nightly encrypted snapshots of the vault to S3-compatible storage |

## Set up

You need a Cloudflare account (the free plan is enough), Node 22.13 or newer, and Python 3.9 or newer on the machine that holds your vault. Everything runs in your own Cloudflare account: your notes are stored in your own D1 database and nowhere else.

**1. Get the code and create the database**

```sh
git clone https://github.com/23alcor/Talisman.git && cd Talisman
npm install
cp wrangler.example.jsonc wrangler.jsonc        # git-ignored: your IDs live here
npx wrangler d1 create talisman                 # paste the database_id into wrangler.jsonc
npx wrangler kv namespace create OAUTH_KV       # paste the id into wrangler.jsonc
```

Fill in `vars` in `wrangler.jsonc`: your first name, your time zone, the title of the note that describes you (`About Me` by default) and the folder your session notes live in (`Sessions` by default).

**2. Deploy and set the secrets**

```sh
npm run db:migrate
npm run deploy                                  # prints your Worker's URL

mkdir -p ~/.config/talisman && chmod 700 ~/.config/talisman
openssl rand -hex 32 > ~/.config/talisman/mcp-token    # for terminal AIs (Claude Code, Codex…)
openssl rand -hex 32 > ~/.config/talisman/sync-token   # for the sync client only
chmod 600 ~/.config/talisman/*-token
npx wrangler secret put TALISMAN_TOKEN < ~/.config/talisman/mcp-token
npx wrangler secret put SYNC_TOKEN < ~/.config/talisman/sync-token
npm run set-password                            # the password you'll type when connecting chat apps
```

**3. Fill the mirror**

On the machine with your vault:

```sh
python3 sync/talisman-sync.py --vault ~/Notes --url https://talisman.YOU.workers.dev \
  --token-file ~/.config/talisman/sync-token --exclude Templates --exclude Attachments
```

It sends only notes that changed and removes notes you deleted. `--exclude Templates` skips every folder named Templates; `--exclude Projects/Old` skips just that one. Folders starting with a dot and notes over 200 KB are always skipped. It refuses to run on an empty folder, or to remove more than half the mirror at once without `--allow-mass-delete`, so a missing drive can't wipe it. Run it on a timer, for example every five minutes with cron:

```
*/5 * * * * python3 /path/to/Talisman/sync/talisman-sync.py --vault /path/to/Notes --url https://talisman.YOU.workers.dev --token-file ~/.config/talisman/sync-token -q
```

**4. Connect your AIs**

- **Chat apps** (claude.ai, the Claude apps, ChatGPT and others that take a custom MCP connector): add a connector with the URL `https://talisman.YOU.workers.dev/mcp`. You'll be asked for your password, then to allow the app.
- **Claude Code:**
  `claude mcp add --transport http talisman https://talisman.YOU.workers.dev/mcp --header "Authorization: Bearer $(cat ~/.config/talisman/mcp-token)"`
- **Other terminal tools:** any client that speaks MCP over HTTP can send `Authorization: Bearer <mcp-token>`.

The connector has six read tools: `whoami`, `search_notes`, `read_note`, `list_notes`, `related_notes` and `recent_sessions`. They can't change anything.

### Development

```sh
npm test                                        # runs on Node's built-in SQLite, no Cloudflare needed
npm run set-password -- --local                 # writes .dev.vars (git-ignored)
echo "TALISMAN_TOKEN=dev-token-123" >> .dev.vars && echo "SYNC_TOKEN=dev-sync-123" >> .dev.vars
npm run db:migrate:local && npm run dev
```

## Roadmap

1. ~~Connector and read mirror~~ (done)
2. Write queue, applier, and the "writes paused" flow
3. Capture hooks for Claude Code and Codex
4. Health: heartbeats, a status page and alerts that don't depend on your home machine
5. Search by meaning, not just keywords
6. Encrypted backups
7. Setup that works for someone who isn't me

Open questions: whether to offer a hosted service later (self-hosted for now); which model providers to support for summaries (OpenAI, Gemini, local).

## Credits

Inspired by [Grimoire](https://github.com/JeremiahM37/grimoire) and the Commonplace hackathon prototype. Talisman is its own code.

## License

[MIT](LICENSE)
