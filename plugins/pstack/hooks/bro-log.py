#!/usr/bin/env python3
"""Post the exchange a /bro restates to the repository's /bro log issue.

Claude Code runs this as an async UserPromptSubmit hook. It reads the hook
payload on stdin and does nothing unless the prompt starts with /bro or
/pstack:bro. It takes the last prompt in the transcript that is not a /bro and
the assistant text after it, finds the open issue titled "/bro log" in
the session's GitHub repository (or PSTACK_BRO_LOG_REPO), creates it when none is open, and adds
one comment. It skips a public repository unless PSTACK_BRO_LOG_REPO names
it. It skips a transcript line that is not a JSON object, and reads and
writes UTF-8 whatever the locale. An @name in the text is posted so it
renders without notifying anyone. A failed git or gh call, a missing remote, or an unreadable transcript
goes to stderr with gh's own error text, and the hook exits 0. The hook runs
async, so it never holds up a prompt. bro-log.sh starts it with python3, or
with python where python3 does not run Python 3, as on many Windows machines.
"""

import datetime
import json
import os
import re
import subprocess
import sys

ISSUE_TITLE = "/bro log"
REPO_OVERRIDE_VARIABLE = "PSTACK_BRO_LOG_REPO"
BRO_PROMPT = re.compile(r"^/(?:pstack:)?bro(?:\s+(?P<arguments>.*))?$", re.DOTALL)
BRO_COMMAND_TAG = re.compile(r"<command-name>/(?:pstack:)?bro</command-name>")
GITHUB_REMOTE = re.compile(
    r"(?:^|@|//)github\.com(?::\d+)?[:/](?P<repository>[^/\s]+/[^/\s]+?)(?:\.git)?/?$"
)
COMMENT_LIMIT = 60000
MENTION = re.compile(r"(?<![\w`])@(?=[A-Za-z0-9])")


def bro_arguments(prompt):
    match = BRO_PROMPT.match(prompt.strip())
    if match is None:
        return None
    return (match.group("arguments") or "").strip()


def text_blocks(entry):
    message = entry.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str):
        return [content]
    return [
        block.get("text") or ""
        for block in content or []
        if isinstance(block, dict) and block.get("type") == "text"
    ]


def is_prompt_entry(entry):
    if entry.get("type") != "user" or entry.get("isMeta"):
        return False
    return bool(text_blocks(entry))


def prompt_text(entry):
    return "\n".join(text_blocks(entry))


def is_bro_entry(text):
    return bro_arguments(text) is not None or BRO_COMMAND_TAG.search(text) is not None


def parsed_line(line):
    try:
        entry = json.loads(line)
    except ValueError:
        return None
    return entry if isinstance(entry, dict) else None


def last_exchange(transcript_path):
    with open(transcript_path, encoding="utf-8") as transcript:
        entries = [entry for entry in map(parsed_line, transcript) if entry]
    prompt = ""
    texts = []
    collecting = False
    for entry in entries:
        if is_prompt_entry(entry):
            text = prompt_text(entry)
            collecting = not is_bro_entry(text)
            if collecting:
                prompt = text
                texts = []
        elif collecting and entry.get("type") == "assistant":
            texts.extend(text_blocks(entry))
    reply = "\n\n".join(text.strip() for text in texts if text.strip())
    return prompt.strip(), reply


def run(arguments, cwd=None, stdin=None):
    return subprocess.run(
        arguments,
        cwd=cwd,
        input=stdin,
        stdin=subprocess.DEVNULL if stdin is None else None,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        check=True,
    ).stdout.strip()


def target_repository(cwd):
    override = os.environ.get(REPO_OVERRIDE_VARIABLE, "").strip()
    if override:
        return override, True
    remote = run(["git", "remote", "get-url", "origin"], cwd=cwd)
    match = GITHUB_REMOTE.search(remote)
    if match is None:
        raise RuntimeError(f"origin {remote} is not a GitHub repository")
    return match.group("repository"), False


def log_issue_number(repository):
    listed = run(
        [
            "gh",
            "api",
            "--paginate",
            f"repos/{repository}/issues?state=open&per_page=100",
            "--jq",
            '.[] | select(.pull_request == null) | "\\(.number)\\t\\(.title)"',
        ]
    )
    numbers = sorted(
        int(number)
        for number, _, title in (line.partition("\t") for line in listed.splitlines())
        if title == ISSUE_TITLE
    )
    if numbers:
        return str(numbers[0])
    body = "Each comment is one /bro: the prompt before it and the reply it restated, from any session in this repository. The pstack bro-log hook writes them."
    return run(
        [
            "gh",
            "api",
            "--method",
            "POST",
            f"repos/{repository}/issues",
            "-f",
            f"title={ISSUE_TITLE}",
            "-f",
            f"body={body}",
            "--jq",
            ".number",
        ]
    )


def without_mentions(text):
    return MENTION.sub("@&#8203;", text)


def quoted(text):
    return "\n".join("> " + line for line in text.splitlines())


def comment_body(payload, arguments, prompt, reply, cwd):
    try:
        branch = run(["git", "branch", "--show-current"], cwd=cwd)
    except (OSError, subprocess.CalledProcessError):
        branch = ""
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        f"**/bro** {stamp}",
        "",
        f"- session: `{payload.get('session_id', '')}`",
        f"- branch: `{branch}`",
        f"- prompt: `/bro{(' ' + arguments) if arguments else ''}`",
        "",
        "Prompt before it:",
        "",
        quoted(without_mentions(prompt)) or "> _(no prompt before this /bro)_",
        "",
        "Reply restated:",
        "",
        without_mentions(reply) or "_(no assistant text before this /bro)_",
    ]
    body = "\n".join(lines)
    if len(body) > COMMENT_LIMIT:
        body = body[:COMMENT_LIMIT] + "\n\n_(truncated)_"
    return body


def main():
    payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    arguments = bro_arguments(payload.get("prompt", ""))
    if arguments is None:
        return
    cwd = payload.get("cwd") or os.getcwd()
    repository, named = target_repository(cwd)
    if not named:
        visibility = run(["gh", "api", f"repos/{repository}", "--jq", ".visibility"])
        if visibility == "public":
            print(
                f"bro-log: {repository} is public; set {REPO_OVERRIDE_VARIABLE} to log there",
                file=sys.stderr,
            )
            return
    prompt, reply = last_exchange(payload["transcript_path"])
    number = log_issue_number(repository)
    run(
        [
            "gh",
            "api",
            "--method",
            "POST",
            f"repos/{repository}/issues/{number}/comments",
            "-F",
            "body=@-",
            "--jq",
            ".html_url",
        ],
        stdin=comment_body(payload, arguments, prompt, reply, cwd),
    )


if __name__ == "__main__":
    try:
        main()
    except (
        OSError,
        KeyError,
        ValueError,
        RuntimeError,
        subprocess.CalledProcessError,
    ) as error:
        detail = getattr(error, "stderr", None) or ""
        print(f"bro-log: {error} {detail}".rstrip(), file=sys.stderr)
