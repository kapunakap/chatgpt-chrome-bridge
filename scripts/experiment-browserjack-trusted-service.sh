#!/usr/bin/env bash
set -euo pipefail

APP="/Applications/ChatGPT.app"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEBUG_SCRIPT="$REPO_ROOT/scripts/experiment-browserjack-live-debug.sh"
CHROME_ROOT="$APP/Contents/Resources/plugins/openai-bundled/plugins/chrome"
BROWSER_ROOT="$APP/Contents/Resources/plugins/openai-bundled/plugins/browser"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ -d "$APP" ]] || fail "$APP is missing"
[[ -f "$DEBUG_SCRIPT" ]] || fail "debug experiment is missing: $DEBUG_SCRIPT"
command -v python3 >/dev/null 2>&1 || fail "python3 is required"

APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null || true)"
[[ -n "$APP_VERSION" ]] || fail "could not read ChatGPT.app version"

# BrowserJack 0.3.0 trusts the bundled Chrome plugin root. Prefer the Chrome
# copy of browser-service.mjs so this experiment changes only the missing
# trusted-service registration and does not broaden NODE_REPL_TRUSTED_CODE_PATHS.
SERVICE_PATH="$CHROME_ROOT/scripts/browser-service.mjs"

if [[ ! -f "$SERVICE_PATH" ]]; then
  echo "trusted_service_candidate_under_existing_browserjack_root=false"
  echo "-- browser-service.mjs candidates --"
  find "$APP/Contents/Resources/plugins/openai-bundled/plugins" \
    -path '*/scripts/browser-service.mjs' -type f -print 2>/dev/null | sort || true
  find "$HOME/.codex/plugins/cache/openai-bundled" \
    -path '*/scripts/browser-service.mjs' -type f -print 2>/dev/null | sort || true
  fail "Chrome plugin has no browser-service.mjs; stop here rather than broadening trust paths implicitly"
fi

if [[ -f "$BROWSER_ROOT/scripts/browser-service.mjs" ]]; then
  CHROME_SHA="$(shasum -a 256 "$SERVICE_PATH" | awk '{print $1}')"
  BROWSER_SHA="$(shasum -a 256 "$BROWSER_ROOT/scripts/browser-service.mjs" | awk '{print $1}')"
  echo "chrome_browser_service_sha256=$CHROME_SHA"
  echo "browser_browser_service_sha256=$BROWSER_SHA"
  if [[ "$CHROME_SHA" == "$BROWSER_SHA" ]]; then
    echo "browser_service_copies_match=true"
  else
    echo "browser_service_copies_match=false"
  fi
fi

TRUSTED_SERVICES="$(python3 - "$SERVICE_PATH" <<'PY'
import json, sys
print(json.dumps({"browser": sys.argv[1]}, separators=(",", ":")))
PY
)"

echo "== trusted browser service experiment =="
echo "app_version=$APP_VERSION"
echo "service_path=$SERVICE_PATH"
echo "service_within_browserjack_trusted_root=true"
echo "service_mapping_keys=browser"
echo "chatgpt_app_modified=false"
echo "installed_browserjack_modified=false"
echo

# These values mirror the newer Codex browser runtime shape seen in current
# generated configs. The underlying debug experiment still uses a disposable
# BrowserJack checkout and preserves its Team ID + browser-client hash checks.
export NODE_REPL_TRUSTED_SERVICES="$TRUSTED_SERVICES"
export BROWSER_USE_CODEX_APP_VERSION="$APP_VERSION"
export BROWSER_USE_CODEX_APP_BUILD_FLAVOR="prod"
export NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS="1000"
export BROWSER_USE_AVAILABLE_BACKENDS="chrome"

set +e
bash "$DEBUG_SCRIPT"
STATUS=$?
set -e

echo
echo "trusted_service_experiment_exit=$STATUS"
if [[ "$STATUS" -eq 0 ]]; then
  echo "TRUSTED_SERVICE_EXPERIMENT_OK=1"
else
  echo "TRUSTED_SERVICE_EXPERIMENT_OK=0"
fi

exit "$STATUS"
