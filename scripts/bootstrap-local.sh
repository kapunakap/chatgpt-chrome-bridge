#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHATGPT_APP="${CHATGPT_APP_PATH:-/Applications/ChatGPT.app}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

printf '== chatgpt-chrome-bridge local bootstrap ==\n'

[[ "$(uname -s)" == "Darwin" ]] || fail "This bridge requires macOS."
[[ "$(uname -m)" == "arm64" ]] || fail "This bridge currently requires Apple Silicon (arm64)."
[[ -d "$CHATGPT_APP" ]] || fail "OpenAI desktop app not found at $CHATGPT_APP. Set CHATGPT_APP_PATH only if you intentionally use another official app bundle."

command -v brew >/dev/null 2>&1 || fail "Homebrew is required. Install Homebrew, then rerun this script."

ensure_node_22() {
  local major=0
  if command -v node >/dev/null 2>&1; then
    major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  fi

  if [[ "$major" -lt 22 ]]; then
    printf 'Node.js 22+ not active; installing Homebrew node@22...\n'
    brew install node@22
    export PATH="$(brew --prefix node@22)/bin:$PATH"
  fi

  command -v node >/dev/null 2>&1 || fail "Node.js is still unavailable after installation."
  major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  [[ "$major" -ge 22 ]] || fail "Node.js 22+ is required; active version is $(node --version)."
  command -v npm >/dev/null 2>&1 || fail "npm is required with Node.js."
  printf 'Node: %s\n' "$(node --version)"
}

ensure_node_22

for cmd in git python3; do
  command -v "$cmd" >/dev/null 2>&1 || fail "$cmd is required."
done

if ! command -v tunnel-client >/dev/null 2>&1; then
  printf 'Installing OpenAI tunnel-client from the official Homebrew tap...\n'
  brew install openai/tools/tunnel-client
fi
printf 'tunnel-client: %s\n' "$(tunnel-client --version)"

printf '\n== Preparing pinned BrowserJack compatibility runtime ==\n'
bash "$REPO_ROOT/scripts/prepare-browserjack.sh"

printf '\n== BrowserJack status ==\n'
"$REPO_ROOT/scripts/browserjack-current.sh" status --json

printf '\n== BrowserJack live handshake ==\n'
"$REPO_ROOT/scripts/browserjack-current.sh" doctor --live --json

printf '\nBOOTSTRAP_OK=1\n'
printf 'Next: store a tunnel runtime API key in ~/.config/chatgpt-browser-bridge/runtime-api-key, then run:\n'
printf '  CONTROL_PLANE_TUNNEL_ID=tunnel_... bash scripts/connect-tunnel.sh\n'
