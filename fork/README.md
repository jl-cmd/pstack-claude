# Fork extensions

This fork tracks michael-denyer/pstack-claude `main`. The nightly upstream sync builds upstream's tree and keeps each path in `FORK_OWNED_PATHS` from this fork. See `.github/workflows/upstream-sync.yml`.

## Hooks

`fork/hooks.json` holds this fork's Claude Code hooks. Each sync appends its event groups to upstream's `plugins/pstack/hooks/hooks.json`, so upstream's own hooks stay as upstream ships them.

| Event              | Script                            | What it does                                                                                                                                                                                                                                                    |
| ------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UserPromptSubmit` | `plugins/pstack/hooks/bro-log.sh` | Starts `bro-log.py` with `python3`, or `python` where `python3` does not run Python 3. On `/bro` or `/pstack:bro`, posts the prompt before it and the reply it restated as one comment on the repository's open "/bro log" issue. It opens that issue when none is open. |

The `/bro` log goes to the GitHub repository of the session's `origin` remote. It skips a public repository. Set `PSTACK_BRO_LOG_REPO` to `owner/name` to log to another repository, public or private. The hook runs async and never blocks a prompt.

## Patches

Each `fork/patches/*.patch` file is a `git diff` against upstream's tree. Each sync applies them in name order after it merges the hooks, so a fork edit inside an upstream file survives the sync while the rest of that file keeps tracking upstream. A patch that no longer applies fails the sync, and the fork's branch stays as it was.

| Patch | What it does |
| ----- | ------------ |
| `poteto-mode-haiku-slim.patch` | Adds the poteto-mode Haiku subagents section and `references/haiku-slim.md`. A Haiku role runs headless on the slim profile with `--autocompact 100k`. |
| `reflect-brief-contract.patch` | Has reflect step 2 append the brief contract lines a local spawn gate requires, such as `Outcome`, after each reviewer template. |

To change a patched file, edit it in place, then rewrite its patch from the synced upstream commit:

```sh
git fetch --depth=1 https://github.com/michael-denyer/pstack-claude.git "$(cat .github/upstream-commit)"
git add --intent-to-add -- plugins/pstack/skills/poteto-mode/
git diff --no-color --src-prefix=a/ --dst-prefix=b/ FETCH_HEAD -- plugins/pstack/skills/poteto-mode/ > fork/patches/poteto-mode-haiku-slim.patch
```

## Regenerate the merged hooks file

After a commit that changes `fork/hooks.json`, rebuild `plugins/pstack/hooks/hooks.json` from that commit and commit the result:

```sh
FORK_OWNED_PATHS=$(sed -n 's/^  FORK_OWNED_PATHS: //p' .github/workflows/upstream-sync.yml)
export FORK_OWNED_PATHS
git fetch --depth=1 https://github.com/michael-denyer/pstack-claude.git "$(cat .github/upstream-commit)"
tree=$(.github/upstream-sync/build-tree.sh "$(cat .github/upstream-commit)" HEAD)
git restore --source "$tree" -- plugins/pstack/hooks/hooks.json
```

The `Fork extensions` CI job fails while the committed file differs from this build.

## Tests

```sh
python3 -m unittest discover -v -s fork/tests
.github/upstream-sync/build-tree.test.sh
```
