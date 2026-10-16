#!/usr/bin/env bash
set -euo pipefail

upstream_commit=$(git rev-parse --verify "$1^{commit}")
fork_commit=$(git rev-parse --verify "$2^{commit}")
marker=.github/upstream-commit
read -ra owned_paths <<< "${FORK_OWNED_PATHS:?}"

index=$(mktemp -u)
trap '[ ! -e "$index" ] || unlink "$index"' EXIT
export GIT_INDEX_FILE="$index"

git read-tree "$upstream_commit"
git ls-files -z -- "${owned_paths[@]}" | xargs -0 -r git update-index --force-remove --
fork_entries=$(git ls-tree -r "$fork_commit" -- "${owned_paths[@]}")
if [ -n "$fork_entries" ]; then
  git update-index --index-info <<< "$fork_entries"
fi
marker_blob=$(git hash-object -w --stdin <<< "$upstream_commit")
git update-index --add --cacheinfo "100644,$marker_blob,$marker"
git write-tree
