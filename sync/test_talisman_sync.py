"""Tests for the sync client's vault scan: python3 -m unittest discover sync"""
import importlib.util
import tempfile
import unittest
import unicodedata
from pathlib import Path

spec = importlib.util.spec_from_file_location("talisman_sync", Path(__file__).with_name("talisman-sync.py"))
ts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ts)


class Scan(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.vault = Path(self.tmp.name)
        files = {
            "Home.md": "---\ntags: [home, start]\n---\nHi",
            "Projects/Lamp/Lamp.md": "---\ntags:\n  - project\n  - '#lamp'\n---\nbody",
            "Projects/Lamp/Transcripts/t1.md": "transcript",
            "Sessions/Transcripts/t2.md": "transcript",
            "Sessions/2026-01-01 Day.md": "session",
            "Projects/Old/x.md": "old",
            "Archive/Old/y.md": "kept: only Projects/Old is excluded",
            "Templates/T.md": "template",
            ".obsidian/workspace.md": "app state",
            "Notes/.hidden.md": "hidden",
            "Notes/picture.png": "not a note",
            unicodedata.normalize("NFD", "Notes/Café.md"): "accent",
            "Notes/big.md": "x" * (ts.MAX_NOTE + 1),
        }
        for rel, text in files.items():
            p = self.vault / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_excludes_names_at_any_depth_and_paths_only_there(self):
        notes, skipped = ts.scan(self.vault, {"Transcripts", "Templates", "Projects/Old"})
        self.assertEqual(sorted(notes), sorted([
            "Archive/Old/y.md", "Home.md", "Notes/Café.md", "Projects/Lamp/Lamp.md", "Sessions/2026-01-01 Day.md",
        ]))
        self.assertEqual(skipped, ["Notes/big.md"])

    def test_note_fields(self):
        notes, _ = ts.scan(self.vault, set())
        lamp = notes["Projects/Lamp/Lamp.md"]
        self.assertEqual((lamp["title"], lamp["folder"], lamp["tags"]), ("Lamp", "Projects/Lamp", "project, lamp"))
        self.assertEqual(notes["Home.md"]["tags"], "home, start")
        self.assertEqual(len(notes["Home.md"]["hash"]), 32)
        self.assertRegex(notes["Home.md"]["updated_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d$")
        self.assertIn("Notes/Café.md", notes)  # stored NFC even when the file name is NFD
        self.assertEqual(notes["Notes/Café.md"]["title"], unicodedata.normalize("NFC", "Café"))

    def test_batches_split_by_count_and_size(self):
        small = [{"body": "x"}] * 250
        self.assertEqual([len(b) for b in ts.batches(small)], [100, 100, 50])
        big = [{"body": "x" * 1_500_000}] * 5
        self.assertEqual([len(b) for b in ts.batches(big)], [2, 2, 1])


if __name__ == "__main__":
    unittest.main()
