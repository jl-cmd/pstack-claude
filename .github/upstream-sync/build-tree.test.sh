#!/usr/bin/env bash
set -euo pipefail

build_tree="$(cd "$(dirname "$0")" && pwd)/build-tree.sh"
repository=$(mktemp -d)
trap 'find "$repository" -delete' EXIT
cd "$repository"
git init -q
git config user.name test
git config user.email test@example.com

write() {
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$2" > "$1"
}

commit_files() {
  git rm -rq --cached --ignore-unmatch . > /dev/null
  git ls-files -z --others | xargs -0 -r git add --
  git commit -qm "$1" --allow-empty
  git rev-parse HEAD
}

reset_worktree() {
  git ls-files -z | xargs -0 -r -n1 unlink
}

write README.md upstream
write .github/workflows/ci.yml "upstream ci"
write .github/upstream-only.yml upstream
write "docs/with space.md" upstream
upstream_commit=$(commit_files upstream)

reset_worktree
write README.md fork
write .github/workflows/ci.yml "fork ci"
write .github/fork-only.yml fork
write .github/run.sh fork
chmod +x .github/run.sh
fork_commit=$(commit_files fork)

failures=0
expect() {
  local tree=$1 path=$2 expected=$3 found
  found=$(git cat-file -p "$tree:$path" 2> /dev/null || echo "<missing>")
  if [ "$found" != "$expected" ]; then
    echo "FAIL $4: $path is '$found', expected '$expected'"
    failures=$((failures + 1))
  fi
}

tree=$(FORK_OWNED_PATHS=.github "$build_tree" "$upstream_commit" "$fork_commit")
expect "$tree" README.md upstream "owned .github"
expect "$tree" "docs/with space.md" upstream "owned .github"
expect "$tree" .github/workflows/ci.yml "fork ci" "owned .github"
expect "$tree" .github/fork-only.yml fork "owned .github"
expect "$tree" .github/upstream-only.yml "<missing>" "owned .github"
expect "$tree" .github/upstream-commit "$upstream_commit" "owned .github"
if [ "$(git ls-tree "$tree" .github/run.sh | cut -c1-6)" != 100755 ]; then
  echo "FAIL owned .github: .github/run.sh lost its executable mode"
  failures=$((failures + 1))
fi

if FORK_OWNED_PATHS='  ' "$build_tree" "$upstream_commit" "$fork_commit" > /dev/null 2>&1; then
  echo "FAIL blank FORK_OWNED_PATHS built a tree"
  failures=$((failures + 1))
fi

tree=$(FORK_OWNED_PATHS='.git*' "$build_tree" "$upstream_commit" "$fork_commit")
expect "$tree" .github/workflows/ci.yml "upstream ci" "literal pathspec"
expect "$tree" .github/fork-only.yml "<missing>" "literal pathspec"
expect "$tree" .github/upstream-commit "$upstream_commit" "literal pathspec"

tree=$(FORK_OWNED_PATHS="README.md .github/fork-only.yml" "$build_tree" "$upstream_commit" "$fork_commit")
expect "$tree" README.md fork "two owned files"
expect "$tree" .github/fork-only.yml fork "two owned files"
expect "$tree" .github/workflows/ci.yml "upstream ci" "two owned files"
expect "$tree" .github/upstream-only.yml upstream "two owned files"

if [ "$(git rev-parse HEAD)" != "$fork_commit" ] || [ -n "$(git diff --cached --name-only)" ]; then
  echo "FAIL the build changed HEAD or the repository index"
  failures=$((failures + 1))
fi

if [ "$failures" -ne 0 ]; then
  exit 1
fi
echo "build-tree.sh: all checks passed"
