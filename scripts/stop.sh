#!/usr/bin/env bash
set -euo pipefail

ALIAS="${TUNNEL_ALIAS:-local-chrome}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_LABEL="${LOCAL_CHROME_LAUNCH_AGENT_LABEL:-com.kapunakap.chatgpt-chrome-bridge.local-chrome}"
SERVICE_PLIST="${LOCAL_CHROME_LAUNCH_AGENT_PLIST:-$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist}"
SERVICE_TARGET="gui/$(id -u)/$SERVICE_LABEL"

if [[ -f "$SERVICE_PLIST" ]] || launchctl print "$SERVICE_TARGET" >/dev/null 2>&1; then
  exec bash "$REPO_ROOT/scripts/service.sh" stop
fi

command -v tunnel-client >/dev/null 2>&1 || {
  printf 'ERROR: tunnel-client not found.\n' >&2
  exit 1
}

tunnel-client runtimes --json stop "$ALIAS"
