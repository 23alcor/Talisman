#!/usr/bin/env python3
"""Copy a Markdown vault (Obsidian or any folder of .md files) into a Talisman read mirror.

Only changed notes are sent; notes deleted from the vault are removed from the mirror.
Python 3.9+, standard library only. Run it on a timer (systemd, launchd, cron) on the machine
that holds the vault.

    TALISMAN_URL=https://talisman.example.workers.dev \\
    TALISMAN_SYNC_TOKEN=... \\
    python3 talisman-sync.py --vault ~/Notes --exclude Templates --exclude Attachments

Settings can come from flags or environment variables:
    --vault        TALISMAN_VAULT        the vault folder
    --url          TALISMAN_URL          your Talisman Worker
    --token-file   TALISMAN_SYNC_TOKEN   the sync token (the file holds it on one line)
    --exclude      TALISMAN_EXCLUDE      folders to skip (comma-separated in the variable): a name such as
                                         Templates skips it at any depth, a path such as Projects/Old only there
Folders starting with a dot (.obsidian, .trash, .git…) are always skipped, as are notes over 200 KB.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path

MAX_NOTE = 200_000          # bytes; the Worker refuses larger notes
BATCH_NOTES = 100
BATCH_BYTES = 4_000_000
MASS_DELETE = 0.5           # refuse to remove more than half the mirror without --allow-mass-delete

nfc = lambda s: unicodedata.normalize("NFC", s)  # macOS file names are NFD; the mirror stores NFC


def tags_of(text):
    """Tags from the frontmatter: `tags: [a, b]`, `tags: a, b` or a `- a` list. Returns 'a, b'."""
    m = re.match(r"---\r?\n(.*?)\r?\n---", text, re.S)
    if not m:
        return ""
    lines, tags = m.group(1).splitlines(), []
    for i, line in enumerate(lines):
        t = re.match(r"tags?:\s*(.*)$", line)
        if not t:
            continue
        value = t.group(1).strip()
        if value:
            tags += [x.strip(" \"'#") for x in value.strip("[]").split(",")]
        else:
            for item in lines[i + 1:]:
                li = re.match(r"\s*-\s+(.*)$", item)
                if not li:
                    break
                tags.append(li.group(1).strip(" \"'#"))
        break
    return ", ".join(t for t in tags if t)


def excluded(rel_dir, excludes):
    """A plain name ("Templates") skips that folder at any depth; a path ("Projects/Old") skips only that folder."""
    name = rel_dir.rsplit("/", 1)[-1]
    return name.startswith(".") or name in excludes or rel_dir in excludes


def scan(vault, excludes):
    notes, skipped = {}, []
    for root, dirs, files in os.walk(vault):
        rel_root = Path(root).relative_to(vault).as_posix()
        dirs[:] = sorted(d for d in dirs if not excluded(nfc(f"{rel_root}/{d}" if rel_root != "." else d), excludes))
        for name in sorted(files):
            if not name.endswith(".md") or name.startswith("."):
                continue
            full = Path(root, name)
            rel = nfc(full.relative_to(vault).as_posix())
            try:
                if full.stat().st_size > MAX_NOTE:
                    skipped.append(rel)
                    continue
                text = full.read_text(encoding="utf-8", errors="replace")
            except OSError as e:
                print(f"skipped {rel}: {e}", file=sys.stderr)
                continue
            if len(text.encode()) > MAX_NOTE:
                skipped.append(rel)
                continue
            parts = rel.split("/")
            notes[rel] = {
                "path": rel,
                "title": nfc(full.stem),
                "folder": "/".join(parts[:-1]),
                "tags": tags_of(text),
                "updated_at": time.strftime("%Y-%m-%dT%H:%M", time.localtime(full.stat().st_mtime)),
                "hash": hashlib.sha256(text.encode()).hexdigest()[:32],
                "body": text,
            }
    return notes, skipped


def request(url, token, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url + "/api/sync/notes", data=data, method=method, headers={
        "authorization": f"Bearer {token}", "content-type": "application/json", "user-agent": "talisman-sync/0.1",
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise SystemExit(f"Talisman answered {e.code}: {e.read().decode(errors='replace')[:300]}")
    except urllib.error.URLError as e:
        raise SystemExit(f"Could not reach Talisman at {url}: {e.reason}")


def batches(notes):
    batch, size = [], 0
    for n in notes:
        b = len(n["body"].encode())
        if batch and (len(batch) >= BATCH_NOTES or size + b > BATCH_BYTES):
            yield batch
            batch, size = [], 0
        batch.append(n)
        size += b
    yield batch


def main():
    p = argparse.ArgumentParser(description="Copy a Markdown vault into a Talisman read mirror.")
    p.add_argument("--vault", default=os.environ.get("TALISMAN_VAULT"))
    p.add_argument("--url", default=os.environ.get("TALISMAN_URL"))
    p.add_argument("--token-file", help="file holding the sync token (default: TALISMAN_SYNC_TOKEN)")
    p.add_argument("--exclude", action="append", default=[], help="folder to skip: a name (any depth) or a path from the vault root; repeatable")
    p.add_argument("--dry-run", action="store_true", help="show what would change, send nothing")
    p.add_argument("--allow-mass-delete", action="store_true", help="allow removing more than half the mirror")
    p.add_argument("-q", "--quiet", action="store_true")
    a = p.parse_args()

    if not a.vault or not a.url:
        p.error("set --vault and --url (or TALISMAN_VAULT and TALISMAN_URL)")
    token = Path(a.token_file).expanduser().read_text().strip() if a.token_file else os.environ.get("TALISMAN_SYNC_TOKEN", "")
    if not token:
        p.error("set TALISMAN_SYNC_TOKEN or --token-file")
    vault = Path(a.vault).expanduser().resolve()
    if not vault.is_dir():
        raise SystemExit(f"No vault folder at {vault}")
    excludes = {nfc(x.strip().strip("/")) for x in a.exclude + os.environ.get("TALISMAN_EXCLUDE", "").split(",") if x.strip()}
    url = a.url.rstrip("/")

    notes, skipped = scan(vault, excludes)
    if not notes:
        raise SystemExit(f"No notes found in {vault}; not syncing, so the mirror is left as it is.")
    remote = request(url, token).get("hashes", {})
    changed = [n for path, n in notes.items() if remote.get(path) != n["hash"]]
    removed = [path for path in remote if path not in notes]
    if remote and len(removed) > MASS_DELETE * len(remote) and len(removed) > 20 and not a.allow_mass_delete:
        raise SystemExit(f"This would remove {len(removed)} of {len(remote)} notes from the mirror. "
                         "Check the vault path, or run again with --allow-mass-delete.")

    summary = f"{len(notes)} notes, {len(changed)} changed, {len(removed)} removed"
    if skipped:
        summary += f", {len(skipped)} over {MAX_NOTE // 1000} KB skipped"
    if a.dry_run:
        print("dry run: " + summary)
        for n in changed[:50]:
            print("  send   " + n["path"])
        for path in removed[:50]:
            print("  remove " + path)
        return
    keep = sorted(notes)
    groups = list(batches(changed)) if changed else [[]]
    for i, group in enumerate(groups):
        body = {"notes": group}
        if i == len(groups) - 1:
            body["keep"] = keep  # the last batch removes what is no longer in the vault
        request(url, token, "PUT", body)
    if not a.quiet:
        print("synced: " + summary)


if __name__ == "__main__":
    main()
