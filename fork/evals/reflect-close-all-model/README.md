# Reflect close-all mode eval

This eval checks the plan a model writes from step 5 of the reflect skill when the user asks to close every finding. It gives a headless `claude -p --model sonnet` the step 5 section, four synthesizer rows, and the request `Close every finding in this run.` The model returns its plan as text plus one structured entry per row. It runs with no tools, no setting sources, and no MCP servers, so it sees only the prompt.

## Files

| File | What it holds |
| ---- | ------------- |
| `cases.json` | The four rows (A1, A2, A3 Accepted; B1 Backlog), the user request, and the two cases. |
| `run.mjs` | Builds the prompt, calls `claude -p` with the prompt on stdin, grades each plan, and prints the scores. `--self-check` grades fixed plans and makes no model call. |

## Cases

| Case | Step 5 text | Expect |
| ---- | ----------- | ------ |
| `close-all` | `plugins/pstack/skills/reflect/SKILL.md` in the working tree | pass on most samples |
| `pre-patch-twin` | The same file at `6bd8db9^`, before the close-all patch | fail on most samples |

## Checks

A plan passes when every check holds for all four rows.

| Check | Holds when |
| ----- | ---------- |
| `one-row-each` | The plan has exactly one entry for each row and no other entries. |
| `drafted` | Each row, Backlog included, has action `draft-fix` and a non-empty draft. |
| `two-verifiers` | Each row's draft goes to two or more verifier agents. |
| `verifiers-correct` | A verifier may change each draft. |
| `lands` | Each fix lands before the run ends. |
| `none-open` | No row is filed to a tracker, and the open items list is empty. |

## Run

```sh
node fork/evals/reflect-close-all-model/run.mjs --self-check
node fork/evals/reflect-close-all-model/run.mjs --out <results dir> --reps 3
```

`--reps` takes 1 to 3. `--cases` takes case ids and stops on an id the fixture lacks. A rerun into the same `--out` skips samples it already holds for the same prompt, system prompt, and model. The summary grades each saved plan again with the current grader. The command exits 0 when every sample is graded, `close-all` passes on most, and `pre-patch-twin` fails on most.

## Scores

Run on 2026-10-22 with `claude-sonnet-5-5` sampled with `run.mjs` at `32340a5` and regraded at `0f332fa`, 3 samples per case, $0.11 reported for all six calls.

| Case | Pass | Per check |
| ---- | ---- | --------- |
| `close-all` | 3/3 | one-row-each 3/3, drafted 3/3, two-verifiers 3/3, verifiers-correct 3/3, lands 3/3, none-open 3/3 |
| `pre-patch-twin` | 0/3 | one-row-each 3/3, drafted 0/3, two-verifiers 0/3, verifiers-correct 0/3, lands 0/3, none-open 0/3 |

`close-all` sample 0: "Send each finding with its draft fix to two independent verifier agents, in parallel. Each verifier confirms the fix or corrects it."

`pre-patch-twin` sample 0: "File B1 to the devex/backlog tracker right away, with tags tooling and ci and the PostToolUse-hook suggestion."

In every twin sample A1 is applied with no verifier and B1 is filed to the tracker.

An earlier run named the A1 action `apply-directly`. Two of three `close-all` samples picked it for the trivial A1 edit while their plan text drafted A1 and sent it to two verifiers, so `close-all` scored 1/3. The label now reads `apply-unreviewed`, and the scores above come from a fresh run after that change.
