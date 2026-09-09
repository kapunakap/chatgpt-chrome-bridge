# Stale BrowserJack identity/session recovery

Local Chrome has four separate health layers. Do not treat the first three as proof that the bridge is usable:

1. **process** — launchd/tunnel-client is running;
2. **tunnel** — the managed runtime reports `healthy=true` and `ready=true`;
3. **discovery** — the OpenAI browser runtime can discover Chrome;
4. **user-scoped readiness** — BrowserJack can bind the current user/session and `tabs.list()` succeeds.

A stale BrowserJack identity/session binding can leave layers 1–3 healthy while layer 4 fails with:

```text
Error: User unavailable
```

The bridge therefore reports Local Chrome ready only after the user-scoped probe confirms `nameSession()` is available and `tabs.list()` succeeds against the stable browser client inside `/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/chrome/scripts/browser-client.mjs`. If no serving agent exists yet, the startup probe creates it and calls `nameSession()` once before listing tabs.

## Persistent self-healing

`scripts/service.sh install` installs two user LaunchAgents:

- `com.kapunakap.chatgpt-chrome-bridge.local-chrome` owns `tunnel-client` and uses `RunAtLoad`, `KeepAlive`, and a bounded `ThrottleInterval`;
- `com.kapunakap.chatgpt-chrome-bridge.local-chrome.health` runs a user-scoped BrowserJack readiness check at a bounded interval.

The health watcher persists only non-secret recovery bookkeeping under `~/.config/chatgpt-browser-bridge/local-chrome-health.json` with mode `600`. It probes the BrowserJack child already owned by the discovery wrapper through `~/.config/chatgpt-browser-bridge/browserjack-live-health.sock`; it never starts a second BrowserJack process. The socket parent is mode `700`, the socket is mode `600`, and its only accepted request is the fixed `{"op":"probe"}` operation. The internal call deliberately has no `x-codex-turn-metadata`, so BrowserJack supplies the same stable stdio-child session policy used for ordinary calls without caller metadata. No external session identifier is captured or persisted. Each probe runs in a scoped async function, reuses `globalThis.agent` when usable, and does not rename an existing serving session.

Recovery policy:

- a successful probe resets the stale-identity failure counter;
- ordinary failures mark the service unhealthy but do not restart it;
- two consecutive `User unavailable` failures arm one recovery attempt;
- recovery uses `launchctl kickstart -k` on the main Local Chrome LaunchAgent;
- the watcher waits for a new, alive launchd PID and reconciles tunnel `healthy + ready` bookkeeping; launchd ownership does not depend on tunnel-client's separate managed-runtime `process_running` field;
- it then re-probes with bounded backoff;
- readiness is restored only after user binding and `tabs.list()` pass;
- a failed recovery remains unhealthy and cannot restart-loop until a later healthy probe resets the state;
- restart timestamps are rate-limited so stale bookkeeping cannot cause rapid repeated restarts.

This is recovery, not an authentication bypass. The BrowserJack/OpenAI user identity check remains intact.

## Status and diagnosis

Run:

```bash
bash scripts/status.sh
bash scripts/service.sh status
node scripts/browserjack-health.mjs probe
node scripts/browserjack-health.mjs state
```

A fully ready persistent service reports all of the following as true:

```text
runtime_process_owner=launchd
launch_agent_pid_alive=true
tunnel_managed_runtime_process_running=false
process_running=true
healthy=true
ready=true
chrome_discovered=true
user_binding_ready=true
tabs_api_ready=true
browser_ready=true
health_watch_ready=true
```

`doctor --live` remains useful for runtime/signature/backend compatibility, but it is not the final readiness gate for this incident class.

For a manually managed runtime, `runtime_process_owner=managed` and tunnel-client's own `process_running=true` remains required.

## Manual acceptance smoke

After installing/restarting the service, use Local Chrome to perform this harmless sequence in a temporary tab:

1. create a new tab;
2. navigate to `https://example.com`;
3. read the title and body (`Example Domain`);
4. click `Learn more`;
5. confirm the resulting IANA page can be read;
6. close the temporary tab.

The smoke test must fail if user-scoped BrowserJack operations return `User unavailable`, even when launchd, tunnel health, and Chrome discovery are otherwise live.

## Incident recovery command

The bounded automatic path uses the same whole-stack recovery mechanism as the successful incident repair:

```bash
launchctl kickstart -k "gui/$(id -u)/com.kapunakap.chatgpt-chrome-bridge.local-chrome"
```

Do not patch out identity checks, reuse stale versioned cache paths, expose a public browser port, or add a second browser extension to solve this class of failure.
