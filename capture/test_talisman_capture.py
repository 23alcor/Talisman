"""Tests for the capture hook: python3 -m unittest discover capture"""
import importlib.util
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location("talisman_capture", Path(__file__).with_name("talisman-capture.py"))
tc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tc)


def cc_line(role, content, **extra):
    return json.dumps({"type": role, "message": {"role": role, "content": content}, "sessionId": "sess-1",
                       "cwd": "/home/sam/lamp", "timestamp": extra.pop("ts", "2026-11-23T14:00:00Z"), **extra})


class Hook(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.state = mock.patch.object(tc, "STATE", self.dir / "state")
        self.state.start()
        self.env = mock.patch.dict(os.environ, {"TALISMAN_CAPTURE": "", "TALISMAN_CAPTURE_SKIP": "", "TALISMAN_CAPTURE_MIN_CHARS": "50"})
        self.env.start()
        self.chat = self.dir / "chat.jsonl"
        self.write([
            cc_line("user", "Fix the lamp's battery drain <private>my salary is 100k</private> please"),
            cc_line("assistant", [{"type": "thinking", "thinking": "hmm"}, {"type": "text", "text": "Looking at power.c now."},
                                  {"type": "tool_use", "name": "Read", "input": {}}]),
            cc_line("user", [{"type": "tool_result", "content": "file contents"}]),
            cc_line("user", "<system-reminder>injected</system-reminder>"),
            cc_line("assistant", "Fixed it. Set OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123 in .env", ts="2026-11-23T14:30:00Z"),
            cc_line("user", "sub-agent text", isSidechain=True),
            "not json",
        ])

    def tearDown(self):
        self.env.stop()
        self.state.stop()
        self.tmp.cleanup()

    def write(self, lines):
        self.chat.write_text("\n".join(lines) + "\n")

    def test_build_keeps_only_what_people_said_and_hides_secrets(self):
        p = tc.build("claude-code", str(self.chat))
        t = p["transcript"]
        self.assertTrue(t.startswith("Tool: claude-code\nWorking directory: /home/sam/lamp\n\nUser: Fix the lamp's battery drain"))
        for gone in ("salary", "hmm", "file contents", "injected", "sub-agent", "sk-proj-"):
            self.assertNotIn(gone, t)
        self.assertIn("Assistant: Looking at power.c now.\n\nFixed it.", t)  # consecutive replies merge
        self.assertIn("OPENAI_API_KEY=[REDACTED", t)
        self.assertEqual((p["started_at"], p["ended_at"]), ("2026-11-23T14:00:00Z", "2026-11-23T14:30:00Z"))
        self.assertEqual(p["capture_id"], tc.build("claude-code", str(self.chat))["capture_id"])  # stable per chat
        self.assertNotEqual(p["capture_id"], tc.build("claude-code", str(self.chat), session_id="other")["capture_id"])

    def test_sends_changes_once_and_final_once(self):
        sent = []
        with mock.patch.object(tc, "send", lambda payload, url, token: sent.append(payload) or {"revision": len(sent)}):
            self.assertTrue(tc.capture("claude-code", str(self.chat), "https://t", "tok").startswith("sent"))
            self.assertEqual(tc.capture("claude-code", str(self.chat), "https://t", "tok"), "skipped: nothing new")
            tc.capture("claude-code", str(self.chat), "https://t", "tok", final=True)  # the end is sent even with no new text
            self.assertEqual(tc.capture("claude-code", str(self.chat), "https://t", "tok", final=True), "skipped: nothing new")
        self.assertEqual([s["final"] for s in sent], [False, True])

    def test_skips(self):
        with mock.patch.object(tc, "send", lambda *a: self.fail("should not send")):
            with mock.patch.dict(os.environ, {"TALISMAN_CAPTURE_MIN_CHARS": "100000"}):
                self.assertTrue(tc.capture("claude-code", str(self.chat), "u", "t").startswith("skipped: only"))
            with mock.patch.dict(os.environ, {"TALISMAN_CAPTURE": "off"}):
                self.assertIn("capture is off", tc.capture("claude-code", str(self.chat), "u", "t"))
            with mock.patch.dict(os.environ, {"TALISMAN_CAPTURE_SKIP": "/tmp/x:/home/sam"}):
                self.assertIn("TALISMAN_CAPTURE_SKIP", tc.capture("claude-code", str(self.chat), "u", "t", cwd="/home/sam/lamp"))
            self.write([cc_line("user", "hello?")])  # no reply yet
            self.assertEqual(tc.capture("claude-code", str(self.chat), "u", "t"), "skipped: no conversation yet")

    def test_hook_entry_points_never_fail_the_agent(self):
        token = self.dir / "token"
        token.write_text("tok\n")
        calls = []
        with mock.patch.object(tc, "send", lambda payload, url, tok: calls.append((payload["final"], url, tok)) or {"revision": 1}):
            hook = json.dumps({"session_id": "sess-1", "transcript_path": str(self.chat), "cwd": "/home/sam/lamp", "hook_event_name": "SessionEnd"})
            with mock.patch("sys.stdin", io.StringIO(hook)):
                self.assertEqual(tc.main(["claude-code", "--url", "https://t", "--token-file", str(token)]), 0)
        self.assertEqual(calls, [(True, "https://t", "tok")])
        with mock.patch.object(tc, "send", side_effect=OSError("offline")), mock.patch("sys.stdin", io.StringIO(hook.replace("SessionEnd", "Stop"))):
            self.assertEqual(tc.main(["claude-code", "--url", "https://t", "--token-file", str(token)]), 0)
        self.assertIn("not sent, will retry: offline", (self.dir / "state" / "capture.log").read_text())
        with mock.patch("sys.stdin", io.StringIO("{not json")):
            self.assertEqual(tc.main(["claude-code", "--url", "https://t", "--token-file", str(token)]), 0)

    def test_redaction_catches_json_keys_connection_strings_and_long_turns(self):
        long_tail = "x" * 20000 + " key sk-ant-" + "a" * 40  # the key sits right where a long turn is cut
        self.write([
            cc_line("user", 'config {"api_key": "abcd1234efgh5678", "password": "hunter2hunter2"} db postgres://sam:s3cretpw@db.local/app'),
            cc_line("assistant", "ok " + long_tail),
        ])
        t = tc.build("claude-code", str(self.chat))["transcript"]
        for leaked in ("abcd1234efgh5678", "hunter2hunter2", "s3cretpw", "a" * 40):
            self.assertNotIn(leaked, t)
        self.assertIn("postgres://sam:[REDACTED]@db.local", t)
        self.assertIn('"api_key": "[REDACTED]', t)

    def test_skip_list_uses_every_folder_the_chat_ran_in(self):
        with mock.patch.object(tc, "send", lambda *a: self.fail("should not send")):
            with mock.patch.dict(os.environ, {"TALISMAN_CAPTURE_SKIP": "/home/sam"}):
                # the hook didn't say where it ran, but the chat file did
                self.assertIn("TALISMAN_CAPTURE_SKIP", tc.capture("claude-code", str(self.chat), "u", "t", cwd=""))
            self.write([cc_line("user", "x" * 100, cwd=""), cc_line("assistant", "y" * 100, cwd="")])
            with mock.patch.dict(os.environ, {"TALISMAN_CAPTURE_SKIP": "/elsewhere"}):
                self.assertIn("can't tell", tc.capture("claude-code", str(self.chat), "u", "t"))

    def test_a_failed_send_is_retried_on_the_next_hook_run(self):
        token = self.dir / "token"
        token.write_text("tok")
        hook = json.dumps({"session_id": "sess-1", "transcript_path": str(self.chat), "cwd": "/home/sam/lamp", "hook_event_name": "SessionEnd"})
        with mock.patch.object(tc, "send", side_effect=OSError("offline")), mock.patch("sys.stdin", io.StringIO(hook)):
            tc.main(["claude-code", "--url", "https://t", "--token-file", str(token)])
        self.assertEqual(len(list((self.dir / "state" / "pending").glob("*.json"))), 1)
        sent = []
        other = self.dir / "other.jsonl"
        other.write_text(cc_line("user", "short"))  # any later hook run, even for another chat, retries first
        with mock.patch.object(tc, "send", lambda p, u, t: sent.append(p["final"]) or {"revision": 1}), \
                mock.patch("sys.stdin", io.StringIO(json.dumps({"transcript_path": str(other), "hook_event_name": "Stop"}))):
            tc.main(["claude-code", "--url", "https://t", "--token-file", str(token)])
        self.assertEqual(sent, [True])  # the ended chat went out, still marked final
        self.assertEqual(list((self.dir / "state" / "pending").glob("*.json")), [])

    def test_codex_hooks_json_passes_the_chat_on_stdin(self):
        home = self.dir / "codex"
        f = home / "sessions/2026/11/23/rollout-2026-11-23T09-00-00-thread-7.jsonl"
        f.parent.mkdir(parents=True)
        f.write_text("\n".join(json.dumps(x) for x in [
            {"type": "session_meta", "payload": {"id": "thread-7", "cwd": "/home/sam/kiln"}},
            {"type": "response_item", "timestamp": "2026-11-23T14:01:00Z", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Speed up the kiln build please"}]}},
            {"type": "response_item", "timestamp": "2026-11-23T14:05:00Z", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Cached the dependency step; builds take 40s now."}]}},
        ]))
        token = self.dir / "token"
        token.write_text("tok")
        sent = []
        with mock.patch.dict(os.environ, {"CODEX_HOME": str(home)}), mock.patch.object(tc, "send", lambda p, u, t: sent.append((p["source"], p["final"], p["capture_id"])) or {"revision": 1}):
            for payload in ({"session_id": "thread-7", "transcript_path": str(f), "cwd": "/home/sam/kiln", "hook_event_name": "Stop"},
                            {"session_id": "thread-7", "cwd": "/home/sam/kiln", "hook_event_name": "SessionEnd"}):  # no path: found by id
                with mock.patch("sys.stdin", io.StringIO(json.dumps(payload))):
                    self.assertEqual(tc.main(["codex", "--url", "https://t", "--token-file", str(token)]), 0)
        self.assertEqual([s[:2] for s in sent], [("codex", False), ("codex", True)])
        self.assertEqual(sent[0][2], sent[1][2])  # the same chat either way

    def test_codex_finds_its_chat_file(self):
        home = self.dir / "codex"
        f = home / "sessions/2026/11/23/rollout-2026-11-23T09-00-00-thread-42.jsonl"
        f.parent.mkdir(parents=True)
        f.write_text("\n".join(json.dumps(x) for x in [
            {"type": "session_meta", "payload": {"id": "thread-42", "cwd": "/home/sam/kiln"}},
            {"type": "response_item", "timestamp": "2026-11-23T14:00:00Z", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "# AGENTS.md instructions for x"}]}},
            {"type": "response_item", "timestamp": "2026-11-23T14:01:00Z", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Add a build cache to the kiln runner"}]}},
            {"type": "response_item", "timestamp": "2026-11-23T14:05:00Z", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Added the cache in runner.py and tests pass."}]}},
        ]))
        token = self.dir / "token"
        token.write_text("tok")
        sent = []
        with mock.patch.dict(os.environ, {"CODEX_HOME": str(home)}), mock.patch.object(tc, "send", lambda p, u, t: sent.append(p) or {"revision": 1}):
            event = json.dumps({"type": "agent-turn-complete", "thread-id": "thread-42", "cwd": "/home/sam/kiln"})
            self.assertEqual(tc.main(["codex", "--url", "https://t", "--token-file", str(token), event]), 0)
        self.assertEqual(len(sent), 1)
        self.assertNotIn("AGENTS.md", sent[0]["transcript"])
        self.assertIn("User: Add a build cache", sent[0]["transcript"])
        self.assertEqual(sent[0]["cwd"], "/home/sam/kiln")


if __name__ == "__main__":
    unittest.main()
