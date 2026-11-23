#!/usr/bin/env python3
"""Talisman capture hook: sends a coding agent's chat to Talisman as it grows, so every session lands in your notes.

Each time the agent finishes a reply, this reads the agent's own chat file and sends a clean transcript to your
Talisman Worker: only what you and the assistant wrote (no tool output, no injected system text), with <private>
spans removed and anything shaped like a key, token or password redacted. One chat is one record, updated in
place. Once a chat has been quiet for a while (or ends), Talisman summarizes it into a session note.

Claude Code (~/.claude/settings.json), Stop and SessionEnd hooks:
    python3 /path/to/Talisman/capture/talisman-capture.py claude-code --url https://talisman.YOU.workers.dev
Codex (~/.codex/hooks.json), Stop and SessionEnd hooks; --background so Codex doesn't wait on the upload:
    python3 /path/to/Talisman/capture/talisman-capture.py codex --background --url https://talisman.YOU.workers.dev
Older Codex without hooks (~/.codex/config.toml; Codex runs only one notify program):
    notify = ["python3", "/path/to/Talisman/capture/talisman-capture.py", "codex", "--url", "https://talisman.YOU.workers.dev"]
Try it on a chat file without sending anything:
    python3 talisman-capture.py build claude-code ~/.claude/projects/<project>/<session>.jsonl

The token is read from --token-file (default ~/.config/talisman/mcp-token) or TALISMAN_TOKEN.
Set TALISMAN_CAPTURE=off to turn capture off, or TALISMAN_CAPTURE_SKIP to a list of folders (separated by ":")
whose chats are never sent. Chats shorter than TALISMAN_CAPTURE_MIN_CHARS (default 1200) are skipped.
It never blocks or fails the agent: problems go to ~/.local/state/talisman/capture.log.
Python 3.9+, standard library only.
"""
import argparse, glob, hashlib, json, os, re, sys, time, urllib.error, urllib.request
from datetime import datetime, timezone
from pathlib import Path

MAX_TURN_CHARS = 12_000        # one huge paste can't crowd out the conversation
MAX_TOTAL_CHARS = 1_200_000    # under Talisman's 1.5 MB limit; longer chats keep the start and the end
STATE = Path(os.path.expanduser("~/.local/state/talisman"))
SOURCES = ("claude-code", "codex")

# Text the tools inject into a conversation that the person never said.
INJECTED = re.compile(
    r"<(system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr|"
    r"local-command-caveat|user-prompt-submit-hook|task-notification|hook_prompt|environment_context|"
    r"user_instructions|turn_aborted|grimoire[\w-]*)\b[^>]*>.*?</\1\s*>", re.S | re.I)
PRIVATE = re.compile(r"<private\b[^>]*>.*?(?:</private\s*>|$)", re.S | re.I)
SECRET_SHAPES = [(k, re.compile(p)) for k, p in [
    ("AWS key", r"\bAKIA[0-9A-Z]{16}\b"),
    ("GitHub token", r"\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b"),
    ("Anthropic key", r"\bsk-ant-[A-Za-z0-9_-]{20,}"),
    ("OpenAI key", r"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}"),
    ("Slack token", r"\bxox[abprs]-[A-Za-z0-9-]{10,}"),
    ("Stripe key", r"\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}"),
    ("Google key", r"\bAIza[0-9A-Za-z_-]{35}\b"),
    ("npm token", r"\bnpm_[A-Za-z0-9]{36}\b"),
    ("JWT", r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
    ("private key", r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)"),
    ("bearer token", r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{20,}"),
]]
# KEY=value, KEY: value and JSON's "key": "value"
ASSIGNMENT = re.compile(
    r"(?i)\b([A-Z0-9_-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)[A-Z0-9_-]*)"
    r"([\"']?\s*[:=]\s*[\"']?)([^\s\"'`,;)]{8,})")
# scheme://user:password@host
URL_PASSWORD = re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://[^\s:/@]+:)([^\s@/]+)(@)")
PLACEHOLDER = re.compile(r"^(?:\$|<|\{|\.\.\.|x{4,}|\*{4,}|your[_-]|redacted|changeme|example)", re.I)


def log(msg):
    try:
        STATE.mkdir(parents=True, exist_ok=True)
        path = STATE / "capture.log"
        if path.exists() and path.stat().st_size > 1_000_000:
            path.replace(STATE / "capture.log.1")
        with open(path, "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")
    except OSError:
        pass


def redact(text):
    count = 0
    for kind, rx in SECRET_SHAPES:
        text, n = rx.subn("[REDACTED " + kind + "]", text)
        count += n

    def hide(m):
        nonlocal count
        if PLACEHOLDER.match(m.group(3)) or m.group(3).startswith("[REDACTED"):
            return m.group(0)
        count += 1
        return m.group(1) + m.group(2) + "[REDACTED]"
    text = ASSIGNMENT.sub(hide, text)
    text, n = URL_PASSWORD.subn(lambda m: m.group(1) + "[REDACTED]" + m.group(3), text)
    return text, count + n


REDACTIONS = [0]  # secrets hidden while reading the current chat


def clean(text):
    """One turn: injected text and private spans removed, secrets redacted before anything is cut."""
    text, n = redact(PRIVATE.sub("", INJECTED.sub("", text)).strip())
    REDACTIONS[0] += n
    if len(text) > MAX_TURN_CHARS:
        keep = MAX_TURN_CHARS // 2
        text = text[:keep] + f"\n[... {len(text) - MAX_TURN_CHARS:,} characters cut ...]\n" + text[-keep:]
    return text


def blocks_text(content, kinds):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") in kinds)
    return ""


def add(turns, role, text):
    if turns and turns[-1][0] == role:
        if turns[-1][1] != text:
            turns[-1] = (role, turns[-1][1] + "\n\n" + text)
    else:
        turns.append((role, text))


def read_claude_code(path):
    """User and assistant words only: tool calls, tool output, thinking, sub-agents and injected text are dropped."""
    turns, meta = [], {"cwd": "", "started": None, "ended": None, "session_id": ""}
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get("type") not in ("user", "assistant") or e.get("isMeta") or e.get("isSidechain") or e.get("isCompactSummary"):
                continue
            m = e.get("message") or {}
            role = m.get("role")
            text = clean(blocks_text(m.get("content"), ("text",) if role == "assistant" else ("text", "input_text")))
            if role not in ("user", "assistant") or not text:
                continue
            meta["cwd"] = meta["cwd"] or e.get("cwd", "")
            meta["session_id"] = meta["session_id"] or e.get("sessionId", "")
            if e.get("timestamp"):
                meta["started"] = meta["started"] or e["timestamp"]
                meta["ended"] = e["timestamp"]
            add(turns, role, text)
    return turns, meta


def read_codex(path):
    """Codex rollout files: the user's and the assistant's messages."""
    turns, meta = [], {"cwd": "", "started": None, "ended": None, "session_id": ""}
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            p = e.get("payload") or {}
            if e.get("type") == "session_meta":
                meta["cwd"] = p.get("cwd", "") or meta["cwd"]
                meta["session_id"] = p.get("id", "") or meta["session_id"]
            if e.get("type") != "response_item" or p.get("type") != "message" or p.get("role") not in ("user", "assistant"):
                continue
            text = clean(blocks_text(p.get("content"), ("input_text", "output_text", "text")))
            if not text or text.lstrip().startswith("# AGENTS.md instructions"):
                continue
            if e.get("timestamp"):
                meta["started"] = meta["started"] or e["timestamp"]
                meta["ended"] = e["timestamp"]
            add(turns, p["role"], text)
    return turns, meta


def utc(ts):
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return None


def build(source, path, cwd="", session_id=""):
    """The capture Talisman would receive for this chat file, or None if there's nothing worth sending."""
    REDACTIONS[0] = 0
    turns, meta = (read_codex if source == "codex" else read_claude_code)(path)
    if not any(r == "user" for r, _ in turns) or not any(r == "assistant" for r, _ in turns):
        return None
    cwd = cwd or meta["cwd"]
    head = [f"Tool: {source}"] + ([f"Working directory: {cwd}"] if cwd else [])
    body = "\n\n".join(("User: " if r == "user" else "Assistant: ") + t for r, t in turns)
    text, n = redact("\n".join(head) + "\n\n" + body)  # again, for secrets split across merged turns
    redactions = REDACTIONS[0] + n
    if len(text) > MAX_TOTAL_CHARS:
        keep = MAX_TOTAL_CHARS // 2
        text = text[:keep] + "\n\n[... middle of a very long session cut ...]\n\n" + text[-keep:]
    sid = session_id or meta["session_id"] or Path(path).stem
    return {
        "capture_id": hashlib.sha256(f"talisman\0{source}\0{sid}".encode()).hexdigest()[:24],
        "source": source, "cwd": cwd or None, "transcript": text,
        "started_at": utc(meta["started"]) if meta["started"] else None,
        "ended_at": utc(meta["ended"]) if meta["ended"] else None,
        "_stats": {"turns": len(turns), "chars": len(text), "redactions": redactions},
    }


def codex_rollout(thread_id):
    """Codex keeps each chat in ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl."""
    home = os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")
    hits = glob.glob(os.path.join(home, "sessions", "*", "*", "*", f"rollout-*{thread_id}.jsonl"))
    return max(hits, key=os.path.getmtime) if hits else None


def skipped(*cwds):
    """Why this chat must not be sent, if it mustn't. Checks every folder the chat is known to have run in."""
    if os.environ.get("TALISMAN_CAPTURE", "").lower() in ("off", "0", "false", "no"):
        return "capture is off (TALISMAN_CAPTURE)"
    skip = [os.path.realpath(os.path.expanduser(f)) for f in os.environ.get("TALISMAN_CAPTURE_SKIP", "").split(":") if f]
    cwds = [os.path.realpath(c) for c in cwds if c]
    if skip and not cwds:
        return "can't tell which folder this chat ran in, and TALISMAN_CAPTURE_SKIP is set"
    for c in cwds:
        if any(c == f or c.startswith(f + os.sep) for f in skip):
            return f"{c} is in TALISMAN_CAPTURE_SKIP"
    return None


def send(payload, url, token, timeout=30):
    body = {k: v for k, v in payload.items() if not k.startswith("_") and v is not None}
    req = urllib.request.Request(url.rstrip("/") + "/api/capture", data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", "authorization": f"Bearer {token}",
                                          "user-agent": "talisman-capture/0.1"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def unchanged(payload, final):
    """Skip a send when this exact transcript already went out (and, for a final send, already went out as final)."""
    mark = STATE / "captures" / payload["capture_id"]
    digest = hashlib.sha256(payload["transcript"].encode()).hexdigest() + (":final" if final else "")
    try:
        if mark.read_text() == digest:
            return True
    except OSError:
        pass
    return False


def remember(payload, final):
    mark = STATE / "captures" / payload["capture_id"]
    try:
        mark.parent.mkdir(parents=True, exist_ok=True)
        mark.write_text(hashlib.sha256(payload["transcript"].encode()).hexdigest() + (":final" if final else ""))
    except OSError:
        pass


def read_cwds(source, path):
    """Every working directory the chat file records (an agent can change folders mid-chat)."""
    out = set()
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            c = e.get("cwd") if source == "claude-code" else (e.get("payload") or {}).get("cwd")
            if isinstance(c, str) and c:
                out.add(c)
    return sorted(out)


# A send that failed (offline, Talisman down) is kept here and tried again on the next hook run, so the last
# turns of a chat aren't lost when the final send fails.
def save_pending(source, path, cwd, session_id, final):
    try:
        d = STATE / "pending"
        d.mkdir(parents=True, exist_ok=True)
        key = hashlib.sha256(f"{source}\0{path}".encode()).hexdigest()[:24]
        old = {}
        try:
            old = json.loads((d / f"{key}.json").read_text())
        except (OSError, ValueError):
            pass
        (d / f"{key}.json").write_text(json.dumps({"source": source, "path": path, "cwd": cwd, "session_id": session_id,
                                                   "final": bool(final or old.get("final")), "at": old.get("at") or time.time()}))
    except OSError:
        pass


def retry_pending(url, token, limit=5):
    d = STATE / "pending"
    for f in sorted(d.glob("*.json"))[:limit] if d.is_dir() else []:
        try:
            p = json.loads(f.read_text())
            if time.time() - p.get("at", 0) > 2 * 86400 or not os.path.isfile(p["path"]):
                f.unlink()
                continue
            log(f"retry: {capture(p['source'], p['path'], url, token, p['cwd'], p['session_id'], p['final'])}")
            f.unlink()
        except (OSError, ValueError, KeyError) as e:
            log(f"retry: still not sent: {e}")
            return  # still offline: try again next time


def capture(source, path, url, token, cwd="", session_id="", final=False):
    if os.environ.get("TALISMAN_CAPTURE", "").lower() in ("off", "0", "false", "no"):
        return "skipped: capture is off (TALISMAN_CAPTURE)"
    payload = build(source, path, cwd, session_id)
    if not payload:
        return "skipped: no conversation yet"
    why = skipped(cwd, payload["cwd"] or "", *read_cwds(source, path))  # also where the chat file says it ran
    if why:
        return f"skipped: {why}"
    min_chars = int(os.environ.get("TALISMAN_CAPTURE_MIN_CHARS") or 1200)
    if len(payload["transcript"]) < min_chars:
        return f"skipped: only {len(payload['transcript'])} characters"
    if unchanged(payload, final):
        return "skipped: nothing new"
    payload["final"] = final
    r = send(payload, url, token)
    remember(payload, final)
    return f"sent {payload['capture_id']} rev {r.get('revision')} ({payload['_stats']['chars']} chars, {payload['_stats']['redactions']} redacted)"


def main(argv):
    p = argparse.ArgumentParser(description="Send a coding agent's chat to Talisman.")
    p.add_argument("mode", choices=["claude-code", "codex", "build"])
    p.add_argument("rest", nargs="*", help="build: <source> <chat file>; codex: the JSON Codex passes")
    p.add_argument("--url", default=os.environ.get("TALISMAN_URL"))
    p.add_argument("--token-file", default=os.path.expanduser("~/.config/talisman/mcp-token"))
    p.add_argument("--background", action="store_true",
                   help="return to the agent at once and send in the background (for agents that wait on their hooks)")
    a = p.parse_intermixed_args(argv)  # Codex appends its JSON after our own --url and --token-file

    if a.mode == "build":
        if len(a.rest) != 2 or a.rest[0] not in SOURCES:
            p.error("build needs: claude-code|codex <chat file>")
        out = build(a.rest[0], a.rest[1])
        print(json.dumps(out, indent=2) if out else "nothing to capture")
        return 0

    try:
        token = os.environ.get("TALISMAN_TOKEN") or Path(a.token_file).expanduser().read_text().strip()
        if not a.url or not token:
            raise ValueError("set --url and a token (--token-file or TALISMAN_TOKEN)")
        if a.mode == "claude-code" or not a.rest:
            # A hook (Claude Code, or Codex's hooks.json): one JSON object on stdin, with the chat file's path.
            hook = json.loads(sys.stdin.read() or "{}")
            path, sid = hook.get("transcript_path"), hook.get("session_id", "")
            if a.mode == "codex" and not path and sid:
                path = codex_rollout(sid)
            job = (a.mode, path, hook.get("cwd", ""), sid, hook.get("hook_event_name") == "SessionEnd")
        else:  # codex's notify setting: one JSON argument after each turn
            event = json.loads(a.rest[-1]) if a.rest else {}
            if event.get("type") != "agent-turn-complete":
                return 0
            thread = event.get("thread-id") or event.get("thread_id") or ""
            job = ("codex", codex_rollout(thread) if thread else None, event.get("cwd", ""), thread, False)
            if not job[1]:
                log(f"codex: no chat file for thread {thread or '?'}")
                return 0
        if not job[1] or not os.path.isfile(job[1]):
            return 0
        if a.background and hasattr(os, "fork") and os.fork() > 0:
            return 0  # the agent carries on; the child below does the sending
        if a.background and hasattr(os, "fork"):
            os.setsid()  # detach, and let go of the agent's pipes so it isn't left waiting on us
            null = os.open(os.devnull, os.O_RDWR)
            for fd in (0, 1, 2):
                os.dup2(null, fd)
        retry_pending(a.url, token)
        try:
            log(f"{a.mode}: {capture(job[0], job[1], a.url, token, job[2], job[3], job[4])}")
        except OSError as e:  # offline or Talisman down: keep it for the next hook run
            save_pending(*job)
            log(f"{a.mode}: not sent, will retry: {e}")
    except (OSError, ValueError) as e:  # a missing token file, bad JSON from the agent
        log(f"{a.mode}: not sent: {e}")
    except Exception as e:  # anything else: still never fail the agent
        log(f"{a.mode}: not sent: {type(e).__name__}: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
