#!/usr/bin/env bash
set -euo pipefail

upstream_commit=$(git rev-parse --verify "$1^{commit}")
fork_commit=$(git rev-parse --verify "$2^{commit}")
marker=.github/upstream-commit
read -ra owned_paths <<< "${FORK_OWNED_PATHS:?}"

index_directory=$(mktemp -d)
trap '[ ! -e "$index_directory/index" ] || unlink "$index_directory/index"; rmdir "$index_directory"' EXIT
export GIT_INDEX_FILE="$index_directory/index"

git read-tree "$upstream_commit"
git ls-files -z -- "${owned_paths[@]}" | xargs -0 -r git update-index --force-remove --
git ls-tree -r -z "$fork_commit" -- "${owned_paths[@]}" | git update-index -z --index-info
marker_blob=$(git hash-object -w --stdin <<< "$upstream_commit")
git update-index --add --cacheinfo "100644,$marker_blob,$marker"
git write-tree
