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
| `maintain-verification-target-lookup.patch` | Makes maintain-verification-skill find its target page from a session the args name, look for that page on origin/main, open PR heads, then sibling worktrees, and report a duplicate or untracked driver before any feature-map edit. Declares the fork in `tools/forks.json`. |
| `reflect-close-all.patch` | Ends each reflect reviewer and synthesizer prompt with Outcome and On a blocker lines, and adds a close-all mode that fixes and independently verifies every row in the same run. Declares the forks in `tools/forks.json`. |

To change a patched file, edit it in place, then rewrite its patch from the synced upstream commit:

```sh
git fetch --depth=1 https://github.com/michael-denyer/pstack-claude.git "$(cat .github/upstream-commit)"
git add --intent-to-add -- plugins/pstack/skills/poteto-mode/
git diff --no-color --src-prefix=a/ --dst-prefix=b/ FETCH_HEAD -- plugins/pstack/skills/poteto-mode/ > fork/patches/poteto-mode-haiku-slim.patch
```

## Evals

`fork/evals/maintain-verification-target-lookup/` checks the plan a headless `claude -p` writes from the maintain-verification-skill text. It runs origin/main's SKILL.md as `baseline` and the working tree's as `v1`, and grades each plan's tool order. Each model call runs through `python ~/.claude/scripts/account_broker.py`, so a model run needs that broker script. `--self-check` grades fixed plans and makes no model call.

```sh
node fork/evals/maintain-verification-target-lookup/run.mjs --self-check
node fork/evals/maintain-verification-target-lookup/run.mjs --out <results dir> --reps 3
```

`fork/evals/reflect-spawn-briefs/` feeds each reflect reviewer and synthesizer template to a spawn hook as an `Agent` prompt and grades the hook's allow or deny. It runs origin/main's templates as `baseline` and the working tree's as `v1`. Twin cases drop the `Outcome:` or `On a blocker:` line and expect a deny. It makes no model call. `--hook` names the hook file; the default is `~/.claude/hooks/routing/spawn_oversight_hook.py`.

```sh
node fork/evals/reflect-spawn-briefs/run.mjs
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
