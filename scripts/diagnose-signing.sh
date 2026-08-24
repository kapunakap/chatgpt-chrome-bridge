#!/usr/bin/env bash
set -u

APP="/Applications/ChatGPT.app"
PLUGIN_ROOT="$APP/Contents/Resources/plugins/openai-bundled/plugins/chrome"
CACHE_ROOT="$HOME/.codex/plugins/cache/openai-bundled/chrome"
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

redact_home() {
  sed "s#${HOME}#~#g"
}

codesign_check() {
  local label="$1"
  local path="$2"
  echo "=== CODESIGN: $label ==="
  printf 'path=%s\n' "$path" | redact_home
  if [[ ! -e "$path" ]]; then
    echo "present=false"
    echo
    return 0
  fi
  echo "present=true"

  local output status
  output="$(/usr/bin/codesign --verify --strict --verbose=4 "$path" 2>&1)"
  status=$?
  echo "strict_verify_exit=$status"
  printf '%s\n' "$output" | redact_home

  echo "-- identity --"
  /usr/bin/codesign -dv --verbose=4 "$path" 2>&1 \
    | grep -E '^(Identifier|TeamIdentifier|Authority|CDHash|Signature|Executable)=' \
    | redact_home || true
  echo
}

if [[ ! -d "$APP" ]]; then
  echo "ERROR: $APP is not present"
  exit 2
fi

printf 'app_version='; /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null || true
printf 'app_build='; /usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist" 2>/dev/null || true
printf 'app_bundle_id='; /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist" 2>/dev/null || true
printf '\n'

codesign_check "ChatGPT.app" "$APP"
codesign_check "codex" "$APP/Contents/Resources/codex"
codesign_check "cua node" "$APP/Contents/Resources/cua_node/bin/node"
codesign_check "cua node_repl" "$APP/Contents/Resources/cua_node/bin/node_repl"
codesign_check "browser peer authorization" "$APP/Contents/Resources/native/browser-use-peer-authorization.node"
codesign_check "codex code-mode host" "$APP/Contents/Resources/codex-code-mode-host"

# Inspect every bundled file in the macOS Chrome native-host directory. This is
# intentionally discovery-only because current OpenAI builds may rename the host.
bundled_host_found=0
if [[ -d "$PLUGIN_ROOT/extension-host/macos" ]]; then
  while IFS= read -r host; do
    [[ -n "$host" ]] || continue
    bundled_host_found=1
    codesign_check "bundled Chrome native-host file" "$host"
  done < <(find "$PLUGIN_ROOT/extension-host/macos" -type f 2>/dev/null | sort)
fi
if [[ "$bundled_host_found" -eq 0 ]]; then
  echo "=== BUNDLED CHROME NATIVE HOST ==="
  echo "present=false"
  echo
fi

echo "=== INSTALLED CHROME NATIVE HOST MANIFESTS ==="
manifest_found=0
if [[ -d "$MANIFEST_DIR" ]]; then
  while IFS= read -r manifest; do
    [[ -n "$manifest" ]] || continue
    manifest_found=1
    printf 'manifest=%s\n' "$manifest" | redact_home
    python3 - "$manifest" <<'PY'
import json, sys
p = sys.argv[1]
try:
    v = json.load(open(p))
except Exception as e:
    print(f"json_error={e}")
    raise SystemExit
print("name=" + str(v.get("name")))
print("path=" + str(v.get("path")))
print("allowed_origins=" + json.dumps(v.get("allowed_origins", []), sort_keys=True))
PY
    host_path="$(python3 - "$manifest" <<'PY'
import json, sys
try:
    v = json.load(open(sys.argv[1]))
    print(v.get("path") or "")
except Exception:
    pass
PY
)"
    if [[ -n "$host_path" ]]; then
      codesign_check "installed Chrome native host" "$host_path"
    fi
  done < <(find "$MANIFEST_DIR" -maxdepth 1 -type f -name 'com.openai*.json' 2>/dev/null | sort)
fi
if [[ "$manifest_found" -eq 0 ]]; then
  echo "present=false"
  echo
fi

echo "=== BROWSER CLIENT INTEGRITY ==="
app_client="$PLUGIN_ROOT/scripts/browser-client.mjs"
cache_client=""
if [[ -e "$CACHE_ROOT/latest/scripts/browser-client.mjs" ]]; then
  cache_client="$(realpath "$CACHE_ROOT/latest/scripts/browser-client.mjs" 2>/dev/null || true)"
fi
printf 'app_client=%s\n' "$app_client" | redact_home
printf 'cache_client=%s\n' "$cache_client" | redact_home
if [[ -f "$app_client" ]]; then
  printf 'app_sha256='; shasum -a 256 "$app_client" | awk '{print $1}'
fi
if [[ -n "$cache_client" && -f "$cache_client" ]]; then
  printf 'cache_sha256='; shasum -a 256 "$cache_client" | awk '{print $1}'
fi
if [[ -f "$app_client" && -n "$cache_client" && -f "$cache_client" ]]; then
  if cmp -s "$app_client" "$cache_client"; then
    echo "app_cache_match=true"
  else
    echo "app_cache_match=false"
  fi
fi

echo
echo "=== LAYOUT METADATA FALLBACK CANDIDATE ==="
if [[ -d "$MANIFEST_DIR" ]]; then
  while IFS= read -r manifest; do
    [[ -n "$manifest" ]] || continue
    python3 - "$manifest" <<'PY'
import json, re, sys
try:
    v = json.load(open(sys.argv[1]))
except Exception:
    raise SystemExit
name = v.get("name")
for origin in v.get("allowed_origins", []) or []:
    m = re.fullmatch(r"chrome-extension://([a-z]{32})/", origin)
    if m:
        print(f"native_host_name={name}")
        print(f"extension_id={m.group(1)}")
PY
  done < <(find "$MANIFEST_DIR" -maxdepth 1 -type f -name 'com.openai*.json' 2>/dev/null | sort)
fi
