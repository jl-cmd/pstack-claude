# Haiku on the slim profile

On Claude Code, a role or panel seat that resolves to Haiku runs as a headless `claude -p` run. It never runs as an `Agent` call.

An `Agent` spawn carries the session's plugins, MCP servers, and CLAUDE.md files. A one-word Haiku reply measured 366k context tokens that way, and 33k on the slim profile.

## Run it

1. Set `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the environment.
2. Send the brief on standard input.
3. Run this from Bash or another POSIX shell. Add `--effort <level>` when the role names one.

```sh
claude -p --model haiku --setting-sources local --settings '{"enabledPlugins": {}, "autoMemoryEnabled": false, "autoCompactWindow": 100000}' --strict-mcp-config --mcp-config '{"mcpServers": {}}' --autocompact 100k
```

PowerShell strips the double quotes inside the single-quoted JSON, so run it from Bash.

## What the slim run lacks

The slim run has no MCP servers, no user plugins, and no CLAUDE.md. Name every file and rule it needs in the brief. Give a job that needs MCP or the repository's instructions to a Sonnet subagent.

## Measured cost

A code review eval graded by an Opus judge. Each run reviews 2 cases 3 times each. The 2 cases hold 7 known bugs, so one run can find at most 21. Two runs of one setting differed by up to 6 bugs.

| Reviewer | Bugs found per run of 21 | Cost per review |
|-|-|-|
| opus, full profile | 16 | $0.73 |
| sonnet, full profile | 17 | $0.30 |
| sonnet medium, slim review profile | 17 | $0.24 |
| sonnet low, slim review profile | 16 | $0.28 |
| haiku high, full profile | 16 | $0.09 |
| haiku low, slim review profile | 10 | $0.03 |
| haiku medium, slim review profile | 15 and 9 | $0.03 |
| haiku high, slim review profile | 12 and 10 | $0.03 |
| haiku xhigh, slim review profile | 8 | $0.03 |

Effort does not move slim Haiku. Slim Haiku costs a third of full Haiku and finds about 11 bugs per run against 16. Give review and judgment seats that need recall to Sonnet.
