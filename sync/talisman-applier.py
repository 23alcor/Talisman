#!/usr/bin/env python3
"""Apply Talisman's write queue to a Markdown vault. Run it on the one machine that holds the main vault.

It claims queued writes from your Talisman Worker in order, writes them into the vault, and reports back with
the notes it changed, so the read mirror updates at once. It is the only thing that writes AI changes into the
vault, and it never edits or deletes what you wrote:

  log_session  a session note in Sessions/YYYY-MM/. Later updates rewrite only that note, and only if nobody
               edited it by hand.
  create_note  a new note in an existing folder. It never overwrites a note.
  --daily-log / --project-log  also add one link line under "## Log" in that day's daily note (created from
               your Obsidian daily-note template if missing) and in the session's project note.
  Captured chats (from capture/talisman-capture.py) also get their transcript saved in Sessions/Transcripts/ and
  linked from the session note, unless --no-transcripts.

    python3 talisman-applier.py --vault ~/Notes --url https://talisman.example.workers.dev \\
        --token-file ~/.config/talisman/sync-token --daily-log --project-log

It runs until stopped (run it as a service); --once applies whatever is waiting and exits.
Python 3.9+, standard library only. Needs talisman-sync.py next to it.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import socket
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import date as Date
from pathlib import Path

_spec = importlib.util.spec_from_file_location("talisman_sync", Path(__file__).with_name("talisman-sync.py"))
ts = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ts)

BAD = re.compile(r'[\x00-\x1f\x7f\\/:#^|\[\]?*"<>]')
HEAD = re.compile(r"^#{1,6} ")


class Refused(Exception):
    """A write that must not be applied as asked. Reported as failed, never retried."""


class Offline(Exception):
    pass


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


# ---------- talking to the Worker ----------
def api(url, token, path, body, timeout=60):
    req = urllib.request.Request(url + path, data=json.dumps(body).encode(), method="POST", headers={
        "authorization": f"Bearer {token}", "content-type": "application/json", "user-agent": "talisman-applier/0.1"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:300]
        if e.code in (401, 403):
            raise SystemExit(f"Talisman refused the token ({e.code}). Check --token-file.")
        raise Offline(f"Talisman answered {e.code}: {detail}")
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise Offline(f"could not reach Talisman: {e}")


def fetch_text(url, token, path, timeout=60):
    req = urllib.request.Request(url + path, headers={"authorization": f"Bearer {token}", "user-agent": "talisman-applier/0.1"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None  # the capture is gone: save the note without a transcript
        raise Offline(f"Talisman answered {e.code} for a transcript")
    except (urllib.error.URLError, OSError) as e:
        raise Offline(f"could not fetch a transcript: {e}")


# ---------- vault helpers ----------
def frontmatter(text):
    m = re.match(r"---\r?\n(.*?)\r?\n---", text, re.S)
    out = {}
    for line in (m.group(1).splitlines() if m else []):
        kv = re.match(r"([A-Za-z_][\w-]*):\s*(.*)$", line)
        if kv:
            out[kv.group(1)] = kv.group(2).strip().strip('"').strip("'")
    return out


def note_hash(text):
    """Hash of a Talisman-managed note without its own hash line, to tell whether a person edited it."""
    return hashlib.sha256(re.sub(r"^talisman_hash:.*\n", "", text, count=1, flags=re.M).encode()).hexdigest()


def inside(vault, rel):
    """The absolute path for `rel`, refusing anything that leaves the vault, hides in a dot folder or goes through a symlink."""
    parts = Path(rel).parts
    if Path(rel).is_absolute() or not parts or any(p in ("..", ".") or p.startswith(".") or "\\" in p for p in parts):
        raise Refused(f"unsafe path: {rel}")
    path = Path(vault, rel)
    for p in [path, *path.parents]:
        if p == Path(vault):
            break
        if p.is_symlink():
            raise Refused(f"refusing to write through a symlink: {rel}")
    if not path.resolve().is_relative_to(Path(vault).resolve()):
        raise Refused(f"path leaves the vault: {rel}")
    return path


def file_mode(path):
    """Keep an existing note's permissions; new notes get the usual ones (mkstemp alone would make them 600)."""
    if path.exists():
        return path.stat().st_mode & 0o777
    mask = os.umask(0)
    os.umask(mask)
    return 0o666 & ~mask


def atomic_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = file_mode(path)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".talisman-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def walk_notes(vault, under=""):
    base = Path(vault, under)
    for root, dirs, files in os.walk(base):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for f in sorted(files):
            if f.endswith(".md") and not f.startswith("."):
                yield Path(root, f)


def note_by_title(vault, title):
    """The note Obsidian would open for [[title]]: same name (any case), shortest path wins."""
    want = ts.nfc(title).casefold()
    hits = [p for p in walk_notes(vault) if ts.nfc(p.stem).casefold() == want]
    return min(hits, key=lambda p: len(str(p))) if hits else None


def record(vault, path):
    """The read-mirror record for a note, built the same way as talisman-sync.py so the next sync sees no change."""
    text = path.read_text(encoding="utf-8")
    rel = ts.nfc(path.relative_to(vault).as_posix())
    return {"path": rel, "title": ts.nfc(path.stem), "folder": "/".join(rel.split("/")[:-1]), "tags": ts.tags_of(text),
            "updated_at": time.strftime("%Y-%m-%dT%H:%M", time.localtime(path.stat().st_mtime)),
            "hash": hashlib.sha256(text.encode()).hexdigest()[:32], "body": text}


def append_to_section(text, heading, line):
    """`text` with `line` added at the end of section `heading` (added at the end if missing).
    Other lines are left alone, except an empty template bullet ('-') in that section."""
    lines = text.splitlines()
    try:
        i = next(k for k, l in enumerate(lines) if l.strip() == heading)
    except StopIteration:
        return "\n".join(lines + ["", heading, line]) + "\n"
    j = i + 1
    while j < len(lines) and not HEAD.match(lines[j]):
        j += 1
    body = [l for l in lines[i + 1:j] if l.strip() != "-"]
    while body and not body[-1].strip():
        body.pop()
    lines[i + 1:j] = body + [line] + ([""] if j < len(lines) else [])
    return "\n".join(lines) + "\n"


# ---------- daily notes (Obsidian's Daily notes settings) ----------
TOKENS = re.compile(r"YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|mm")


def moment(fmt, d, hm="00:00"):
    """Format a date with the common moment.js tokens Obsidian uses (YYYY-MM-DD, dddd, MMMM D, YYYY…)."""
    v = {"YYYY": f"{d.year}", "YY": f"{d.year % 100:02d}", "MMMM": d.strftime("%B"), "MMM": d.strftime("%b"),
         "MM": f"{d.month:02d}", "M": f"{d.month}", "DD": f"{d.day:02d}", "D": f"{d.day}",
         "dddd": d.strftime("%A"), "ddd": d.strftime("%a"), "HH": hm[:2], "mm": hm[3:5]}
    out, i = [], 0
    for m in re.finditer(r"\[([^\]]*)\]|" + TOKENS.pattern, fmt):  # [literal] text stays as is
        out.append(fmt[i:m.start()])
        out.append(m.group(1) if m.group(1) is not None else v[m.group(0)])
        i = m.end()
    return "".join(out) + fmt[i:]


def daily_settings(vault):
    try:
        cfg = json.loads(Path(vault, ".obsidian", "daily-notes.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cfg = {}
    template = (cfg.get("template") or "").strip()
    if template and not template.endswith(".md"):
        template += ".md"
    return (cfg.get("folder") or "").strip("/"), cfg.get("format") or "YYYY-MM-DD", template


def daily_note(vault, day, hm):
    """Path of the daily note for `day` (YYYY-MM-DD), created from the template if it doesn't exist yet."""
    folder, fmt, template = daily_settings(vault)
    d = Date.fromisoformat(day)
    rel = "/".join(x for x in (folder, moment(fmt, d) + ".md") if x)
    path = inside(vault, rel)
    if not path.exists():
        text = ""
        if template and inside(vault, template).is_file():
            text = Path(vault, template).read_text(encoding="utf-8")
            text = re.sub(r"\{\{date:([^}]*)\}\}", lambda m: moment(m.group(1), d, hm), text)
            text = re.sub(r"\{\{time:([^}]*)\}\}", lambda m: moment(m.group(1), d, hm), text)
            text = text.replace("{{date}}", day).replace("{{time}}", hm).replace("{{title}}", path.stem)
        atomic_write(path, text or f"# {path.stem}\n\n## Log\n")
    return path


# ---------- the two kinds of write ----------
def bullets(items, check=False):
    items = [str(x).strip() for x in (items or []) if str(x).strip()]
    return "\n".join(("- [ ] " if check else "- ") + x for x in items) if items else "- None"


def session_text(p, revision, name):
    study = p.get("kind") == "study"
    category = re.sub(r"[^a-z]", "", str(p.get("category") or "other").lower()) or "other"
    tool = re.sub(r"[^\w-]", "", str(p.get("source") or "ai").lower()) or "ai"
    lines = ["---", "type: session", f"kind: {'study' if study else 'work'}", f"category: {category}",
             f'project: "[[{p["project"]}]]"' if p.get("project") else "project: ",
             f'date: "{p["date"]}"', f'start: "{p.get("start", "")}"', f'end: "{p.get("end", "")}"', f"tool: {tool}",
             "created_by: talisman", f"talisman_session: {p['session_id']}", f"talisman_rev: {revision}",
             "tags:", "  - session", f"  - {category}", "---", f"# {p['title']}", "", "## Summary", p.get("summary") or "- None"]
    concepts = [re.sub(r"[\[\]|#^]", "", str(c)).strip() for c in (p.get("concepts") or [])][:5]
    if any(concepts):
        lines += ["", "Concepts: " + " · ".join(f"[[{c}]]" for c in concepts if c)]
    if study:
        sections = [("What I covered", p.get("changes"), False), ("Key ideas", p.get("decisions"), False),
                    ("Still unclear", p.get("still_unclear"), False), ("Review next", p.get("next_steps"), True)]
    else:
        sections = [("What changed", p.get("changes"), False), ("Decisions", p.get("decisions"), False),
                    ("Next steps", p.get("next_steps"), True)]
    for head, items, check in sections:
        lines += ["", f"## {head}", bullets(items, check)]
    lines += ["", "## Links", bullets(p.get("links")), ""]
    text = "\n".join(lines)
    return text.replace(f"talisman_rev: {revision}\n", f"talisman_rev: {revision}\ntalisman_hash: {note_hash(text)}\n", 1)


def find_session(vault, sessions_folder, sid):
    if not Path(vault, sessions_folder).is_dir():
        return None
    for path in walk_notes(vault, sessions_folder):
        head = path.read_text(encoding="utf-8", errors="replace")[:2000]
        fm = frontmatter(head) if f"talisman_session: {sid}\n" in head else {}
        if fm.get("created_by") == "talisman" and fm.get("type") == "session":  # not its transcript, which shares the id
            return path
    return None


def free_name(vault, base):
    """A note name nobody in the vault uses yet, so [[links]] never clash."""
    names = {ts.nfc(p.stem).casefold() for p in walk_notes(vault)}
    name, n = base, 2
    while name.casefold() in names:
        name, n = f"{base} ({n})", n + 1
    return name


def write_transcript(vault, rel, text, name, tool, sid):
    """The chat's transcript as its own note, rewritten as the chat grows. Never replaces a note Talisman didn't write."""
    path = inside(vault, rel)
    if path.exists():
        fm = frontmatter(path.read_text(encoding="utf-8", errors="replace")[:2000])
        if fm.get("created_by") != "talisman" or fm.get("talisman_session") != sid:
            log(f"left {rel} alone: it isn't this session's transcript")
            return
    longest = max((len(m) for m in re.findall(r"`+", text)), default=0)
    fence = "`" * max(3, longest + 1)
    atomic_write(path, "\n".join(["---", "type: transcript", f'session: "[[{name}]]"', f"source: {tool}", "created_by: talisman",
                                  f"talisman_session: {sid}", "---", f"Transcript for [[{name}]].", "", fence + "text", text.rstrip(), fence, ""]))


def apply_session(vault, w, cfg, daily_log=False, project_log=False, fetch_transcript=None):
    p, revision = w["payload"], int(w["revision"])
    sessions = (cfg.get("sessions_folder") or "Sessions").strip("/")
    existing = find_session(vault, sessions, p["session_id"])
    project = note_by_title(vault, p["project"]) if p.get("project") else None
    already = False
    if existing:
        current = existing.read_text(encoding="utf-8")
        fm = frontmatter(current)
        already = int(fm.get("talisman_rev") or 0) >= revision  # a retry after a lost report
        if not already and fm.get("talisman_hash") != note_hash(current):
            raise Refused("this session note was edited by hand, so Talisman kept that version. Log more work with a new session.")
        path = existing
    else:
        label = BAD.sub(" ", (frontmatter(project.read_text(encoding="utf-8")).get("code") if project else "") or (project.stem if project else "General"))
        title = BAD.sub(" ", p["title"]).strip() or "Session"
        name = free_name(vault, re.sub(r"\s+", " ", f"{p['date']} {label} - {title}").strip()[:150])
        path = inside(vault, f"{sessions}/{p['date'][:7]}/{name}.md")
    name, tool = path.stem, re.sub(r"[^\w-]", "", str(p.get("source") or "ai").lower()) or "ai"
    transcript = None
    if p.get("transcript_capture") and fetch_transcript:  # a captured chat: keep its transcript next to the note
        transcript = fetch_transcript(p["transcript_capture"])
        if transcript:
            p = {**p, "links": list(p.get("links") or []) + [f"Full transcript: [[{sessions}/Transcripts/{name}|transcript]]"]}
    if not already:
        atomic_write(path, session_text(p, revision, path.stem))
    if transcript:
        write_transcript(vault, f"{sessions}/Transcripts/{name}.md", transcript, name, tool, p["session_id"])
    touched = [path]  # transcripts stay out of the read mirror; the log lines below check for themselves
    if daily_log:
        daily = daily_note(vault, p["date"], p.get("start") or "00:00")
        text = daily.read_text(encoding="utf-8")
        if f"[[{name}]]" not in text:
            atomic_write(daily, append_to_section(text, "## Log", f"- {p.get('start') or '00:00'} [{tool}] {p['title']} → [[{name}]]"))
        touched.append(daily)
    if project_log and project:
        text = project.read_text(encoding="utf-8")
        has_log = any(l.strip() == "## Log" for l in text.splitlines())
        if (has_log or frontmatter(text).get("type") in ("project", "course")) and f"[[{name}|" not in text:
            atomic_write(project, append_to_section(text, "## Log", f"- {p['date']} [[{name}|{p['title']}]] ({tool})"))
            touched.append(project)
    return path, touched


def apply_note(vault, w, cfg):
    p = w["payload"]
    title, folder = p["title"], p["folder"].strip("/")
    if BAD.search(title) or not title.strip():
        raise Refused("bad note title")
    daily_folder, _, template = daily_settings(vault)
    protected = {x.casefold() for x in (daily_folder, str(Path(template).parent) if template else "", cfg.get("sessions_folder") or "Sessions") if x and x != "."}
    if any(folder.casefold() == x or folder.casefold().startswith(x + "/") for x in protected):
        raise Refused("notes can't be created in the daily notes, templates or sessions folders")
    dirpath = inside(vault, folder)
    if not dirpath.is_dir():
        raise Refused(f"the folder {folder} doesn't exist in the vault")
    path = inside(vault, f"{folder}/{title}.md")
    if path.exists():
        if frontmatter(path.read_text(encoding="utf-8")).get("talisman_write") == w["id"]:
            return path, [path]  # already applied
        raise Refused(f"a note already exists at {folder}/{title}.md; Talisman never overwrites notes")
    clash = note_by_title(vault, title)
    if clash:
        raise Refused(f"a note named {title} already exists at {clash.relative_to(vault).as_posix()}")
    source = re.sub(r"[^\w-]", "", str(p.get("source") or "ai").lower()) or "ai"
    text = "\n".join(["---", "created_by: talisman", f"talisman_write: {w['id']}", f"source: {source}", f'created: "{p.get("date", "")}"',
                      "---", f"# {title}", "", p["content"].rstrip(), ""])
    atomic_write(path, text)
    return path, [path]


def apply(vault, w, cfg, args):
    if w["kind"] == "session":
        fetch = None if getattr(args, "no_transcripts", False) else getattr(args, "fetch_transcript", None)
        return apply_session(vault, w, cfg, args.daily_log, args.project_log, fetch)
    if w["kind"] == "note":
        return apply_note(vault, w, cfg)
    raise Refused(f"this applier doesn't know writes of kind {w['kind']}; update it")


# ---------- main loop ----------
def handle(vault, url, token, w, cfg, args):
    try:
        path, touched = apply(vault, w, cfg, args)
        rel = path.relative_to(vault).as_posix()
        api(url, token, "/api/applier/done", {"id": w["id"], "status": "saved", "path": ts.nfc(rel),
                                              "notes": [record(vault, t) for t in dict.fromkeys(touched)]})
        log(f"saved {w['kind']} {w['id']} → {rel}")
    except Refused as e:
        api(url, token, "/api/applier/done", {"id": w["id"], "status": "failed", "error": str(e)})
        log(f"refused {w['kind']} {w['id']}: {e}")
    except (OSError, KeyError, TypeError, ValueError) as e:
        api(url, token, "/api/applier/done", {"id": w["id"], "status": "retry", "error": f"{type(e).__name__}: {e}"[:300]})
        log(f"will retry {w['kind']} {w['id']}: {e}")


def main():
    p = argparse.ArgumentParser(description="Apply Talisman's write queue to a Markdown vault.")
    p.add_argument("--vault", default=os.environ.get("TALISMAN_VAULT"))
    p.add_argument("--url", default=os.environ.get("TALISMAN_URL"))
    p.add_argument("--token-file", help="file holding the sync token (default: TALISMAN_SYNC_TOKEN)")
    p.add_argument("--daily-log", action="store_true", help="add a link line to the daily note's ## Log")
    p.add_argument("--project-log", action="store_true", help="add a link line to the project note's ## Log")
    p.add_argument("--no-transcripts", action="store_true", help="don't save captured chats' transcripts in the vault")
    p.add_argument("--once", action="store_true", help="apply what is waiting, then exit")
    p.add_argument("--state-dir", default=os.path.expanduser("~/.local/state/talisman"))
    a = p.parse_args()
    if not a.vault or not a.url:
        p.error("set --vault and --url (or TALISMAN_VAULT and TALISMAN_URL)")
    token = Path(a.token_file).expanduser().read_text().strip() if a.token_file else os.environ.get("TALISMAN_SYNC_TOKEN", "")
    if not token:
        p.error("set TALISMAN_SYNC_TOKEN or --token-file")
    vault = Path(a.vault).expanduser().resolve()
    if not vault.is_dir() or not any(walk_notes(vault)):
        raise SystemExit(f"No vault with notes at {vault}")
    url = a.url.rstrip("/")

    os.makedirs(a.state_dir, mode=0o700, exist_ok=True)
    lock = open(os.path.join(a.state_dir, "applier.lock"), "a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("Another applier is already running for this machine.")

    a.fetch_transcript = lambda cid: fetch_text(url, token, f"/api/applier/transcript/{cid}")
    name, backoff = socket.gethostname()[:60], 5
    log(f"applying writes into {vault}" + (" (once)" if a.once else ""))
    while True:
        try:
            r = api(url, token, "/api/applier/claim", {"name": name, "wait": 0 if a.once else 20}, timeout=45)
            backoff = 5
            for w in r.get("writes", []):
                handle(vault, url, token, w, r.get("config", {}), a)
            if a.once and not r.get("writes"):
                return
        except Offline as e:
            if a.once:
                raise SystemExit(str(e))
            log(f"{e}; trying again in {backoff}s")
            time.sleep(backoff)
            backoff = min(backoff * 2, 120)


if __name__ == "__main__":
    main()
