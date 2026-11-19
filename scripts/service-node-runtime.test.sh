#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES="$REPO_ROOT/scripts/test-fixtures/node-runtime"

source "$REPO_ROOT/scripts/node-runtime.sh"
SERVICE_PATH=''
NODE_BIN=''

# A healthy explicit PATH choice takes precedence over all fallbacks.
SERVICE_PATH="$FIXTURES/healthy-26:$FIXTURES/healthy-24"
select_node_runtime
[[ "$NODE_BIN" == "$FIXTURES/healthy-26/node" ]]
[[ "${SERVICE_PATH%%:*}" == "$FIXTURES/healthy-26" ]]

# A broken default Node is skipped in favor of the first healthy supported fallback.
SERVICE_PATH="$FIXTURES/broken"
select_node_runtime "$SERVICE_PATH" "$FIXTURES/healthy-24/node"
[[ "$NODE_BIN" == "$FIXTURES/healthy-24/node" ]]
[[ "${SERVICE_PATH%%:*}" == "$FIXTURES/healthy-24" ]]

# A runnable but unsupported Node version is rejected.
SERVICE_PATH="$FIXTURES/unsupported-20"
select_node_runtime "$SERVICE_PATH" "$FIXTURES/healthy-22/node"
[[ "$NODE_BIN" == "$FIXTURES/healthy-22/node" ]]

# No working supported executable fails with a repair hint.
SERVICE_PATH="$FIXTURES/broken"
if output="$(select_node_runtime "$SERVICE_PATH" "$FIXTURES/broken/node" 2>&1)"; then
  printf 'unsupported Node unexpectedly passed selection\n' >&2
  exit 1
fi
[[ "$output" == *'No working Node.js 22+ executable was found'* ]]

printf 'Node runtime selection regression checks passed\n'
