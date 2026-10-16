#!/usr/bin/env bash
set -euo pipefail

upstream_commit=$(git rev-parse --verify "$1^{commit}")
fork_commit=$(git rev-parse --verify "$2^{commit}")
marker=.github/upstream-commit
fork_hooks=fork/hooks.json
plugin_hooks=plugins/pstack/hooks/hooks.json
read -ra owned_paths <<< "${FORK_OWNED_PATHS:?}"
if [ "${#owned_paths[@]}" -eq 0 ]; then
  echo "FORK_OWNED_PATHS names no path" >&2
  exit 1
fi
export GIT_LITERAL_PATHSPECS=1

index_directory=$(mktemp -d)
trap '[ ! -e "$index_directory/index" ] || unlink "$index_directory/index"; rmdir "$index_directory"' EXIT
export GIT_INDEX_FILE="$index_directory/index"

git read-tree "$upstream_commit"
git ls-files -z -- "${owned_paths[@]}" | xargs -0 -r git update-index --force-remove --
git ls-tree -r -z "$fork_commit" -- "${owned_paths[@]}" | git update-index -z --index-info
marker_blob=$(git hash-object -w --stdin <<< "$upstream_commit")
git update-index --add --cacheinfo "100644,$marker_blob,$marker"
if git ls-files --error-unmatch -- "$fork_hooks" > /dev/null 2>&1; then
  merged_hooks_blob=$(
    jq -s '.[1].hooks as $fork | .[0] | .hooks |= reduce ($fork | to_entries[]) as $event (.; .[$event.key] += $event.value)' \
      <(git cat-file blob "$upstream_commit:$plugin_hooks") <(git cat-file blob ":$fork_hooks") |
      git hash-object -w --stdin
  )
  git update-index --add --cacheinfo "100644,$merged_hooks_blob,$plugin_hooks"
fi
git write-tree
