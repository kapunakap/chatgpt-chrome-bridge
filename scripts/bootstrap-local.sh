#!/usr/bin/env bash
set -euo pipefail

BROWSERJACK_VERSION="0.3.0"
BROWSERJACK_SHIM="$HOME/Library/Application Support/browserjack/bin/browserjack"
CHATGPT_APP="${CHATGPT_APP_PATH:-/Applications/ChatGPT.app}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

printf '== chatgpt-browser-bridge local bootstrap ==\n'

[[ "$(uname -s)" == "Darwin" ]] || fail "BrowserJack requires macOS."
[[ "$(uname -m)" == "arm64" ]] || fail "BrowserJack currently requires Apple Silicon (arm64)."
[[ -d "$CHATGPT_APP" ]] || fail "OpenAI desktop app not found at $CHATGPT_APP. Set CHATGPT_APP_PATH only if you intentionally use another official app bundle."

printf 'Verifying OpenAI desktop app signature before exposing its browser runtime...\n'
if ! /usr/bin/codesign --verify --strict "$CHATGPT_APP" >/dev/null 2>&1; then
  app_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$CHATGPT_APP/Contents/Info.plist" 2>/dev/null || true)"
  app_build="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$CHATGPT_APP/Contents/Info.plist" 2>/dev/null || true)"
  fail "BLOCKED_UPSTREAM_OPENAI_SIGNATURE: $CHATGPT_APP version ${app_version:-unknown} build ${app_build:-unknown} fails macOS strict code-signature verification. Do not bypass this check. See OpenAI Codex issues #40025 and #40407; rerun after installing a corrected OpenAI build."
fi
printf 'OpenAI desktop app signature: valid\n'

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
  command -v npx >/dev/null 2>&1 || fail "npx is required with Node.js."
  printf 'Node: %s\n' "$(node --version)"
}

ensure_node_22

if ! command -v tunnel-client >/dev/null 2>&1; then
  printf 'Installing OpenAI tunnel-client from the official Homebrew tap...\n'
  brew install openai/tools/tunnel-client
fi

printf 'tunnel-client: %s\n' "$(tunnel-client --version)"

printf 'Installing BrowserJack %s in runtime-only mode...\n' "$BROWSERJACK_VERSION"
npx --yes "browserjack@${BROWSERJACK_VERSION}" setup --client plugin --scope user

[[ -x "$BROWSERJACK_SHIM" ]] || fail "Expected BrowserJack shim is missing or not executable: $BROWSERJACK_SHIM"

printf '\n== BrowserJack status ==\n'
"$BROWSERJACK_SHIM" status --json

printf '\n== BrowserJack live handshake ==\n'
"$BROWSERJACK_SHIM" doctor --live --json

printf '\n== tunnel-client quickstart availability ==\n'
tunnel-client help quickstart >/dev/null
printf 'OK: tunnel-client quickstart help is available.\n'

printf '\nBOOTSTRAP_OK=1\n'
printf 'Next: obtain CONTROL_PLANE_TUNNEL_ID and CONTROL_PLANE_API_KEY, then run bash scripts/connect-tunnel.sh\n'
