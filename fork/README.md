# Fork extensions

This fork tracks michael-denyer/pstack-claude `main`. The nightly upstream sync builds upstream's tree and keeps each path in `FORK_OWNED_PATHS` from this fork. See `.github/workflows/upstream-sync.yml`.

## Hooks

`fork/hooks.json` holds this fork's Claude Code hooks. Each sync appends its event groups to upstream's `plugins/pstack/hooks/hooks.json`, so upstream's own hooks stay as upstream ships them.

| Event              | Script                            | What it does                                                                                                                                                                                                                                                    |
| ------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UserPromptSubmit` | `plugins/pstack/hooks/bro-log.sh` | Starts `bro-log.py` with `python3`, or `python` where `python3` does not run. On `/bro` or `/pstack:bro`, posts the prompt before it and the reply it restated as one comment on the repository's open "/bro log" issue. It opens that issue when none is open. |

The `/bro` log goes to the GitHub repository of the session's `origin` remote. It skips a public repository. Set `PSTACK_BRO_LOG_REPO` to `owner/name` to log to another repository, public or private. The hook runs async and never blocks a prompt.

## Tests

```sh
python3 -m unittest discover -v -s fork/tests
.github/upstream-sync/build-tree.test.sh
```
