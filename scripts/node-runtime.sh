#!/usr/bin/env bash

# Select a Node executable that can actually start and meets the supported
# minimum. Set NODE_BIN and pin its directory to the front of SERVICE_PATH.
node_runtime_is_supported() {
  local candidate="$1"
  local version=''
  local major=''

  [[ -f "$candidate" && -x "$candidate" ]] || return 1
  version="$("$candidate" -p 'process.versions.node' 2>/dev/null)" || return 1
  [[ "$version" =~ ^([0-9]+)\.[0-9]+\.[0-9]+ ]] || return 1
  major="${BASH_REMATCH[1]}"
  (( major >= 22 ))
}

select_node_runtime() {
  local requested_path="${1:-$SERVICE_PATH}"
  local candidate=''
  local node_dir=''
  local path_entry=''
  local primary=''
  local candidates=()
  local test_candidates=false

  if (( $# > 1 )); then
    shift
    candidates=("$@")
    test_candidates=true
  fi

  primary="$(PATH="$requested_path" command -v node 2>/dev/null || true)"
  if [[ -n "$primary" ]] && node_runtime_is_supported "$primary"; then
    candidate="$primary"
  else
    if [[ "$test_candidates" == false ]]; then
      candidates=(
        /opt/homebrew/opt/node@24/bin/node
        /opt/homebrew/opt/node@22/bin/node
        /usr/local/opt/node@24/bin/node
        /usr/local/opt/node@22/bin/node
      )
      # Also recognize versioned Node executables in explicitly supplied PATHs.
      local old_ifs="$IFS"
      IFS=:
      for path_entry in $requested_path; do
        [[ -n "$path_entry" ]] || path_entry='.'
        candidates+=(
          "$path_entry/node24"
          "$path_entry/node22"
          "$path_entry/node@24"
          "$path_entry/node@22"
        )
      done
      IFS="$old_ifs"
      candidates+=(
        /opt/homebrew/bin/node
        /usr/local/bin/node
        /usr/bin/node
      )
    fi

    for candidate in "${candidates[@]}"; do
      if node_runtime_is_supported "$candidate"; then
        break
      fi
      candidate=''
    done
  fi

  if [[ -z "$candidate" ]]; then
    printf '%s\n' 'ERROR: No working Node.js 22+ executable was found. Repair the Node on PATH or install Homebrew node@24 or node@22, then rerun this command.' >&2
    return 1
  fi

  NODE_BIN="$candidate"
  node_dir="$(cd "$(dirname "$NODE_BIN")" && pwd -P)"
  SERVICE_PATH="$node_dir:$requested_path"
}
