#!/usr/bin/env bash
set -euo pipefail

redact_home() {
  sed "s#${HOME}#~#g"
}

plist_value() {
  local plist="$1"
  local key="$2"
  /usr/libexec/PlistBuddy -c "Print :${key}" "$plist" 2>/dev/null || true
}

inspect_app() {
  local app="$1"
  echo "=== APP ${app} ==="
  if [[ ! -d "$app" ]]; then
    echo "present=false"
    echo
    return 0
  fi

  local plist="$app/Contents/Info.plist"
  echo "present=true"
  echo "bundle_id=$(plist_value "$plist" CFBundleIdentifier)"
  echo "version=$(plist_value "$plist" CFBundleShortVersionString)"
  echo "build=$(plist_value "$plist" CFBundleVersion)"

  echo "-- expected BrowserJack paths --"
  local plugin_root="$app/Contents/Resources/plugins/openai-bundled/plugins/chrome"
  for path in \
    "$plugin_root/.codex-plugin/plugin.json" \
    "$plugin_root/scripts/extension-id.json" \
    "$plugin_root/scripts/browser-client.mjs" \
    "$app/Contents/Resources/cua_node/manifest.json" \
    "$app/Contents/Resources/codex"
  do
    if [[ -e "$path" ]]; then
      printf 'FOUND %s\n' "$path" | redact_home
    else
      printf 'MISSING %s\n' "$path" | redact_home
    fi
  done

  echo "-- matching files anywhere under app Resources --"
  find "$app/Contents/Resources" \
    \( -name 'extension-id.json' -o -name 'browser-client.mjs' -o -path '*/.codex-plugin/plugin.json' \) \
    -print 2>/dev/null | sort | redact_home || true
  echo
}

inspect_app "/Applications/ChatGPT.app"
inspect_app "$HOME/Applications/ChatGPT.app"
inspect_app "/Applications/Codex.app"
inspect_app "$HOME/Applications/Codex.app"

echo "=== CODEX CACHE ==="
cache_root="$HOME/.codex/plugins/cache/openai-bundled/chrome"
if [[ -d "$cache_root" ]]; then
  echo "present=true"
  find "$cache_root" \
    \( -name 'extension-id.json' -o -name 'browser-client.mjs' -o -path '*/.codex-plugin/plugin.json' \) \
    -print 2>/dev/null | sort | redact_home || true
  if [[ -e "$cache_root/latest" ]]; then
    printf 'latest='; realpath "$cache_root/latest" 2>/dev/null | redact_home || true
  fi
else
  echo "present=false"
fi

echo

echo "=== BROWSERJACK CURRENT DOCTOR ==="
BROWSERJACK_BIN="$HOME/Library/Application Support/browserjack/bin/browserjack"
if [[ -x "$BROWSERJACK_BIN" ]]; then
  "$BROWSERJACK_BIN" doctor --json 2>&1 | redact_home || true
else
  echo "browserjack stable shim missing or not executable: ~/Library/Application Support/browserjack/bin/browserjack"
fi
