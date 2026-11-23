"""Tests for the applier's vault writes: python3 -m unittest discover sync"""
import importlib.util
import json
import os
import tempfile
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("talisman_applier", Path(__file__).with_name("talisman-applier.py"))
ap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ap)

CFG = {"sessions_folder": "Sessions"}
ARGS = SimpleNamespace(daily_log=True, project_log=True)


def session(rev=1, **p):
    payload = {"session_id": "ses_abc123", "title": "Ship the beta", "kind": "work", "category": "coding", "project": "Lantern",
               "summary": "Shipped it.", "changes": ["Built it"], "decisions": ["Go"], "still_unclear": [], "next_steps": ["Fix battery"],
               "links": ["repo"], "source": "claude", "date": "2026-11-22", "start": "21:40", "end": "21:55", **p}
    return {"id": f"w_{rev}", "kind": "session", "revision": rev, "payload": payload}


def note(**p):
    payload = {"title": "Lamp ideas", "folder": "Projects/Lantern", "path": "Projects/Lantern/Lamp ideas.md", "content": "Warm light.", "source": "chatgpt", "date": "2026-11-22", **p}
    return {"id": "w_note1", "kind": "note", "revision": 1, "payload": payload}


class Applier(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        v = self.vault = Path(self.tmp.name).resolve()
        files = {
            ".obsidian/daily-notes.json": json.dumps({"folder": "Journal/Daily", "format": "YYYY-MM-DD", "template": "Templates/Daily"}),
            "Templates/Daily.md": "---\ndate: \"{{date:YYYY-MM-DD}}\"\n---\n# {{date:dddd, MMMM D, YYYY}}\n\n## Log\n- \n\n## Notes\nwrite here\n",
            "Projects/Lantern/Lantern.md": "---\ntype: project\n---\n# Lantern\n\n## Log\n- 2026-11-01 old entry\n\n## Ideas\nmine\n",
            "Courses/EECE 448.md": "---\ntype: course\ncode: EECE 448\n---\n# ML\n",
            "Home.md": "# Home\nno log section\n",
        }
        for rel, text in files.items():
            Path(v, rel).parent.mkdir(parents=True, exist_ok=True)
            Path(v, rel).write_text(text, encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def read(self, rel):
        return Path(self.vault, rel).read_text(encoding="utf-8")

    def test_new_session_note_with_daily_and_project_logs(self):
        path, touched = ap.apply(self.vault, session(), CFG, ARGS)
        rel = path.relative_to(self.vault).as_posix()
        self.assertEqual(rel, "Sessions/2026-11/2026-11-22 Lantern - Ship the beta.md")
        text = self.read(rel)
        self.assertIn('project: "[[Lantern]]"', text)
        self.assertIn("talisman_session: ses_abc123\ntalisman_rev: 1\ntalisman_hash: ", text)
        self.assertIn("## What changed\n- Built it", text)
        self.assertIn("## Next steps\n- [ ] Fix battery", text)
        daily = self.read("Journal/Daily/2026-11-22.md")
        self.assertIn("# Sunday, November 22, 2026", daily)  # made from the template
        self.assertIn("## Log\n- 21:40 [claude] Ship the beta → [[2026-11-22 Lantern - Ship the beta]]\n\n## Notes", daily)
        project = self.read("Projects/Lantern/Lantern.md")
        self.assertIn("- 2026-11-01 old entry\n- 2026-11-22 [[2026-11-22 Lantern - Ship the beta|Ship the beta]] (claude)\n\n## Ideas\nmine", project)
        self.assertEqual(len(touched), 3)
        self.assertEqual(ap.record(self.vault, path)["path"], rel)

    def test_updates_rewrite_in_place_and_retries_add_nothing(self):
        path, _ = ap.apply(self.vault, session(), CFG, ARGS)
        path2, _ = ap.apply(self.vault, session(2, summary="Shipped it and fixed the battery.", end="22:30"), CFG, ARGS)
        self.assertEqual(path, path2)
        self.assertIn("talisman_rev: 2", path.read_text())
        self.assertIn("fixed the battery", path.read_text())
        ap.apply(self.vault, session(2), CFG, ARGS)  # a retry of an applied revision changes nothing
        self.assertIn("fixed the battery", path.read_text())
        self.assertEqual(self.read("Journal/Daily/2026-11-22.md").count("[[2026-11-22 Lantern - Ship the beta]]"), 1)
        self.assertEqual(self.read("Projects/Lantern/Lantern.md").count("[[2026-11-22 Lantern - Ship the beta|"), 1)

    def test_hand_edited_session_is_kept(self):
        path, _ = ap.apply(self.vault, session(), CFG, ARGS)
        path.write_text(path.read_text() + "\nmy own thoughts\n")
        with self.assertRaises(ap.Refused):
            ap.apply(self.vault, session(2, summary="new"), CFG, ARGS)
        self.assertIn("my own thoughts", path.read_text())

    def test_names_never_clash_and_labels_use_course_codes(self):
        Path(self.vault, "2026-11-22 EECE 448 - Ship the beta.md").write_text("taken")
        path, _ = ap.apply(self.vault, session(session_id="ses_other1", project="EECE 448", kind="study"), CFG, ARGS)
        self.assertEqual(path.name, "2026-11-22 EECE 448 - Ship the beta (2).md")
        self.assertIn("## What I covered", path.read_text())
        self.assertIn("## Review next\n- [ ] Fix battery", path.read_text())
        self.assertIn("## Log\n- 2026-11-22 [[2026-11-22 EECE 448 - Ship the beta (2)|Ship the beta]]", self.read("Courses/EECE 448.md"))
        # a project note that is neither a project/course nor has a ## Log is left alone
        _, touched = ap.apply(self.vault, session(session_id="ses_home123", project="Home"), CFG, ARGS)
        self.assertEqual(self.read("Home.md"), "# Home\nno log section\n")
        self.assertEqual(len(touched), 2)

    def test_create_note_and_its_refusals(self):
        path, _ = ap.apply(self.vault, note(), CFG, ARGS)
        self.assertEqual(path.read_text(), '---\ncreated_by: talisman\ntalisman_write: w_note1\nsource: chatgpt\ncreated: "2026-11-22"\n---\n# Lamp ideas\n\nWarm light.\n')
        ap.apply(self.vault, note(), CFG, ARGS)  # the same write again is fine
        cases = {
            "exists": dict(w=dict(note(), id="w_other")),
            "same title elsewhere": dict(w=note(folder="Courses", title="Lantern")),
            "no such folder": dict(w=note(folder="Nope", title="New one")),
            "daily folder": dict(w=note(folder="Journal/Daily", title="New one")),
            "templates": dict(w=note(folder="Templates", title="New one")),
            "sessions": dict(w=note(folder="Sessions", title="New one")),
            "escape": dict(w=note(folder="../outside", title="New one")),
            "dot folder": dict(w=note(folder=".obsidian", title="New one")),
        }
        os.makedirs(Path(self.vault, "Sessions"), exist_ok=True)
        for name, c in cases.items():
            with self.subTest(name), self.assertRaises(ap.Refused):
                ap.apply(self.vault, c["w"], CFG, ARGS)
        self.assertFalse(Path(self.tmp.name).parent.joinpath("outside").exists())

    def test_symlinks_are_refused(self):
        outside = tempfile.TemporaryDirectory()
        try:
            os.symlink(outside.name, Path(self.vault, "Linked"))
            with self.assertRaises(ap.Refused):
                ap.apply(self.vault, note(folder="Linked", title="New one"), CFG, ARGS)
            self.assertEqual(os.listdir(outside.name), [])
        finally:
            outside.cleanup()

    def test_helpers(self):
        self.assertEqual(ap.moment("dddd, MMMM D, YYYY", date(2026, 1, 5)), "Monday, January 5, 2026")
        self.assertEqual(ap.moment("YYYY/[Week] MM-DD", date(2026, 1, 5)), "2026/Week 01-05")
        self.assertEqual(ap.append_to_section("# T\n## Log\n- \n## Next\nx\n", "## Log", "- a"), "# T\n## Log\n- a\n\n## Next\nx\n")
        self.assertEqual(ap.append_to_section("# T\n", "## Log", "- a"), "# T\n\n## Log\n- a\n")
        self.assertEqual(ap.frontmatter('---\na: "1"\nb: x\n---\nbody'), {"a": "1", "b": "x"})


if __name__ == "__main__":
    unittest.main()
