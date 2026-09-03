#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$REPO_ROOT/scripts/review-browserjack-update.sh"

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/browserjack-review-rollback.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

target="$TEST_ROOT/target.json"
backup="$TEST_ROOT/backup"
printf 'before\n' >"$target"
chmod 600 "$target"
snapshot_file "$target" "$backup"
printf 'after\n' >"$target"
restore_file "$target" "$backup"
[[ "$(<"$target")" == "before" ]]
if [[ "$(uname -s)" == "Darwin" ]]; then
  target_mode="$(stat -f '%Lp' "$target")"
else
  target_mode="$(stat -c '%a' "$target")"
fi
[[ "$target_mode" == "600" ]]

absent="$TEST_ROOT/absent.json"
absent_backup="$TEST_ROOT/absent-backup"
snapshot_file "$absent" "$absent_backup"
printf 'temporary\n' >"$absent"
restore_file "$absent" "$absent_backup"
[[ ! -e "$absent" ]]

printf 'review_rollback_tests=pass\n'
