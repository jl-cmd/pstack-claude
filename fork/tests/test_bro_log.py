"""Run bro-log.py against a fake gh and a git checkout, and read what it posted."""

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import textwrap
import unittest

HOOK = pathlib.Path(__file__).resolve().parents[2] / "plugins/pstack/hooks/bro-log.py"

FAKE_GH = textwrap.dedent(
    """\
    #!/usr/bin/env python3
    import json, os, pathlib, sys
    state = pathlib.Path(os.environ["FAKE_GH_STATE"])
    calls = json.loads(state.read_text()) if state.exists() else {"calls": [], "issues": []}
    arguments = sys.argv[1:]
    stdin = sys.stdin.read() if "body=@-" in arguments else ""
    calls["calls"].append({"arguments": arguments, "stdin": stdin})
    paths = [argument for argument in arguments if argument.startswith("repos/")]
    path = paths[0] if paths else ""
    posting = "POST" in arguments
    if path.endswith("/comments") and posting:
        print(f"https://github.com/{path[6:]}/1")
    elif "/issues?" in path:
        for issue in calls["issues"]:
            print(f"{issue['number']}\t{issue['title']}")
    elif path.endswith("/issues") and posting:
        number = 40 + len(calls["issues"])
        title = next(argument[6:] for argument in arguments if argument.startswith("title="))
        calls["issues"].append({"number": number, "title": title})
        print(number)
    elif path.count("/") == 2:
        print(os.environ.get("FAKE_GH_VISIBILITY", "private"))
    state.write_text(json.dumps(calls))
    """
)


def user(content, **extra):
    return {"type": "user", "message": {"role": "user", "content": content}, **extra}


def assistant(*texts):
    return {
        "type": "assistant",
        "message": {
            "role": "assistant",
            "content": [{"type": "text", "text": text} for text in texts],
        },
    }


def tool_use():
    return {
        "type": "assistant",
        "message": {
            "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {}}]
        },
    }


def tool_result():
    return user([{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}])


class BroLogTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.directory.name)
        bin_directory = self.root / "bin"
        bin_directory.mkdir()
        gh = bin_directory / "gh"
        gh.write_text(FAKE_GH)
        gh.chmod(0o755)
        self.checkout = self.root / "checkout"
        self.checkout.mkdir()
        subprocess.run(
            ["git", "init", "-q", "-b", "work", str(self.checkout)], check=True
        )
        subprocess.run(
            [
                "git",
                "-C",
                str(self.checkout),
                "remote",
                "add",
                "origin",
                "git@github.com:owner/name.git",
            ],
            check=True,
        )
        self.state = self.root / "gh.json"
        self.environment = {
            key: value
            for key, value in os.environ.items()
            if key != "PSTACK_BRO_LOG_REPO"
        }
        self.environment["PATH"] = f"{bin_directory}{os.pathsep}{os.environ['PATH']}"
        self.environment["FAKE_GH_STATE"] = str(self.state)

    def tearDown(self):
        self.directory.cleanup()

    def run_hook(self, prompt, entries, **environment):
        transcript = self.root / "transcript.jsonl"
        transcript.write_text("".join(json.dumps(entry) + "\n" for entry in entries))
        payload = {
            "session_id": "session-1",
            "transcript_path": str(transcript),
            "cwd": str(self.checkout),
            "hook_event_name": "UserPromptSubmit",
            "prompt": prompt,
        }
        completed = subprocess.run(
            [sys.executable, str(HOOK)],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            env={**self.environment, **environment},
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        calls = (
            json.loads(self.state.read_text())["calls"] if self.state.exists() else []
        )
        return completed, calls

    def comments(self, calls):
        return [call for call in calls if call["arguments"][3].endswith("/comments")]

    def creates(self, calls):
        return [
            call
            for call in calls
            if "POST" in call["arguments"] and call["arguments"][3].endswith("/issues")
        ]

    def test_a_prompt_without_bro_posts_nothing(self):
        completed, calls = self.run_hook("explain the sync", [assistant("hi")])
        self.assertEqual(calls, [])
        self.assertEqual(completed.stderr, "")

    def test_bro_creates_the_log_issue_and_posts_the_exchange(self):
        entries = [
            user("why did the nightly fail?"),
            assistant("The sync step exits 1 on Cursor-term hits."),
            tool_use(),
            tool_result(),
            assistant("So the PR step never ran."),
        ]
        _, calls = self.run_hook("/bro", entries)
        [create] = self.creates(calls)
        self.assertIn("title=/bro log", create["arguments"])
        [comment] = self.comments(calls)
        self.assertEqual(comment["arguments"][3], "repos/owner/name/issues/40/comments")
        body = comment["stdin"]
        self.assertIn("> why did the nightly fail?", body)
        self.assertIn(
            "The sync step exits 1 on Cursor-term hits.\n\nSo the PR step never ran.",
            body,
        )
        self.assertIn("- branch: `work`", body)
        self.assertIn("- session: `session-1`", body)

    def test_a_second_bro_reuses_the_open_issue(self):
        self.state.write_text(
            json.dumps(
                {
                    "calls": [],
                    "issues": [
                        {"number": 7, "title": "/bro log"},
                        {"number": 3, "title": "/bro log old"},
                    ],
                }
            )
        )
        _, calls = self.run_hook(
            "/pstack:bro shorter please", [user("q"), assistant("a")]
        )
        self.assertEqual(self.creates(calls), [])
        [comment] = self.comments(calls)
        self.assertEqual(comment["arguments"][3], "repos/owner/name/issues/7/comments")
        self.assertIn("- prompt: `/bro shorter please`", comment["stdin"])

    def test_bro_skips_earlier_bro_exchanges(self):
        entries = [
            user("first question"),
            assistant("first answer"),
            user("<command-name>/bro</command-name>\n<command-args></command-args>"),
            assistant("plain first answer"),
        ]
        _, calls = self.run_hook("/bro", entries)
        body = self.comments(calls)[0]["stdin"]
        self.assertIn("> first question", body)
        self.assertIn("first answer", body)
        self.assertNotIn("plain first answer", body)

    def test_meta_entries_are_not_prompts(self):
        entries = [
            user("the question"),
            user("skill text", isMeta=True),
            assistant("the answer"),
        ]
        _, calls = self.run_hook("/bro", entries)
        body = self.comments(calls)[0]["stdin"]
        self.assertIn("> the question", body)
        self.assertIn("the answer", body)

    def test_a_public_repository_is_skipped(self):
        completed, calls = self.run_hook(
            "/bro", [user("q"), assistant("a")], FAKE_GH_VISIBILITY="public"
        )
        self.assertEqual(self.comments(calls), [])
        self.assertIn("owner/name is public", completed.stderr)

    def test_the_override_names_the_repository(self):
        _, calls = self.run_hook(
            "/bro",
            [user("q"), assistant("a")],
            FAKE_GH_VISIBILITY="public",
            PSTACK_BRO_LOG_REPO="me/log",
        )
        self.assertNotIn(
            ["api", "repos/me/log", "--jq", ".visibility"],
            [call["arguments"] for call in calls],
        )
        self.assertNotIn(
            ["api", "repos/owner/name", "--jq", ".visibility"],
            [call["arguments"] for call in calls],
        )
        self.assertEqual(
            self.comments(calls)[0]["arguments"][3], "repos/me/log/issues/40/comments"
        )

    def test_a_failure_never_blocks_the_prompt(self):
        subprocess.run(
            ["git", "-C", str(self.checkout), "remote", "remove", "origin"], check=True
        )
        completed, calls = self.run_hook("/bro", [user("q"), assistant("a")])
        self.assertEqual(calls, [])
        self.assertIn("bro-log:", completed.stderr)


if __name__ == "__main__":
    unittest.main()
