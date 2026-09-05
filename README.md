# ChatGPT Chrome Bridge

<img width="1672" height="941" alt="ChatGPT → Secure MCP Tunnel → Chrome on Personal Mac" src="https://github.com/user-attachments/assets/6ddbd299-ef4a-4fad-941b-7b3864252e3d" />

Control your existing signed-in Chrome on your Mac from ChatGPT through OpenAI Secure MCP Tunnel and [BrowserJack](https://github.com/stickerdaniel/browserjack).

**Uses OpenAI's existing official Chrome extension. No additional Chrome extension is installed.**

This is an **unofficial, experimental bridge**. It opens no public inbound port, runs no hosted browser, and installs no extra browser extension. ChatGPT reaches a local stdio MCP server through OpenAI's official `tunnel-client`; BrowserJack then reuses the browser runtime already installed by the official ChatGPT/Codex desktop app.

## Architecture

```text
ChatGPT
  -> OpenAI Secure MCP Tunnel
  -> tunnel-client on your Mac
  -> BrowserJack stdio MCP
  -> OpenAI browser runtime
  -> existing signed-in Chrome
```

## Compatibility

The bridge is deliberately fail-closed to an exact browser-runtime fingerprint rather than a marketing app version. The signed plugin metadata is feature-detected from either `extension-ids.json` or the legacy `extension-id.json`; the Chrome store ID is selected from the signed Chrome entry, never from the first native-host origin.

When signed browser content is unchanged, a new app version/build is tested once by the local BrowserJack runtime and cached as an exact per-build result. A changed browser fingerprint is admitted only through a real live self-test; the exact fingerprint is written to the private local approval file only after that test succeeds. Identity, signature, byte-identity, and containment mismatches always fail closed.

The Local Chrome supervisor watches the signed app generation. After a compatible update, it revalidates the new generation and exits instead of swapping BrowserJack under the existing process-affine stdio connection. `tunnel-client` then shuts down, and the launchd `KeepAlive` service starts a fresh tunnel-client process, supervisor, BrowserJack child, and MCP session. An unapproved or incompatible generation remains fail-closed in the existing supervisor with explicit unavailable errors, without repeatedly exiting into a launchd restart loop.

BrowserJack 0.3.0 does not understand the current OpenAI desktop layout/signing behavior used by this tested build. `scripts/prepare-browserjack.sh` builds a pinned BrowserJack checkout with the narrow compatibility adaptation used by this project and makes the live doctor require a real Chrome backend. The tested build continues to run BrowserJack inside its restricted outer Codex sandbox. No OpenAI binary, extension, browser profile, or app bundle is modified or redistributed.

## Requirements

Successful `js_reset` responses and the live `js` tool description include the current signed-app bootstrap URL. Literal dynamic imports of removed versioned browser clients are rejected with current guidance before execution; calls are never rewritten or replayed. Computed import expressions are left to the runtime.

`BRIDGE_LOCAL_READY=1` covers startup and backend discovery only. Page-operation acceptance requires `node scripts/browserjack-mcp-smoke.mjs`; failures include the exact smoke stage.

- macOS on Apple Silicon
- official ChatGPT/Codex desktop app installed at `/Applications/ChatGPT.app`
- the official ChatGPT/Codex Chrome integration already installed and working in Chrome
- Homebrew
- Node.js 22+ (the bootstrap script installs Homebrew `node@22` when needed)
- official OpenAI `tunnel-client 0.0.13` (the bootstrap upgrades through `openai/tools` and fails closed on another version)
- an OpenAI Secure MCP Tunnel associated with your Platform organization and ChatGPT workspace
- a runtime API key with **Tunnels Read + Use**, stored in a local mode-`600` file
- ChatGPT developer mode / permission to create a custom app

Official tunnel documentation: [OpenAI Secure MCP Tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

## 1. Provision the OpenAI tunnel

Do this once in the OpenAI Platform organization you want to use:

1. Open **OpenAI Platform → Tunnels** and create a tunnel.
2. Associate it with the ChatGPT workspace where you will create the browser app.
3. Copy the resulting `tunnel_...` ID.
4. Create or use a runtime API key for a principal with **Tunnels Read + Use**.
5. Store that key outside this repository and restrict it to your user.

For example:

```bash
mkdir -p "$HOME/.config/chatgpt-browser-bridge"
chmod 700 "$HOME/.config/chatgpt-browser-bridge"
umask 077
cat > "$HOME/.config/chatgpt-browser-bridge/runtime-api-key"
# paste the runtime API key, then press Ctrl-D
chmod 600 "$HOME/.config/chatgpt-browser-bridge/runtime-api-key"
```

Never commit the key or paste it into GitHub issues, logs, screenshots, or shell commands that would expose the value in process arguments.

## 2. Install the local bridge

```bash
git clone https://github.com/kapunakap/chatgpt-chrome-bridge.git
cd chatgpt-chrome-bridge
bash scripts/bootstrap-local.sh
```

The bootstrap installs/validates local prerequisites and builds the pinned BrowserJack compatibility runtime under:

```text
~/.codex/chatgpt-browser-bridge/browserjack/8ee11377-compat-v1
```

It does not modify `ChatGPT.app`, Chrome, the OpenAI Chrome extension, or your browser profile.

### Review a real browser-runtime change

If you want an explicit review of a desktop update that changes an approved browser component hash, run:

```bash
bash scripts/review-browserjack-update.sh
```

The command verifies the fixed identities, shows only non-secret hashes, stages the candidate for the live doctor and direct Chrome smoke test, and writes the exact approved fingerprint to a private mode-`600` file only after both checks pass. Normal service startup also performs the signed candidate live self-test without a repository hash change. A failed review restores the earlier local compatibility state and leaves Local Chrome stopped.

Local approvals are stored outside the repository at `~/.config/chatgpt-browser-bridge/browser-runtime-approvals.json`. App version/build changes with an already approved fingerprint need no command or repository edit; BrowserJack self-tests each new build once.
The prepared adapter and bridge-owned BrowserJack verified-build cache live under `${CODEX_HOME:-$HOME/.codex}/chatgpt-browser-bridge/browserjack` because the OpenAI Browser sandbox allows writes under `CODEX_HOME`. Launchd logs and unrelated outer state remain unchanged.

## 3. Connect the tunnel

Set your own tunnel ID and connect:

```bash
CONTROL_PLANE_TUNNEL_ID=tunnel_... bash scripts/connect-tunnel.sh
```

Optional overrides:

- `TUNNEL_ALIAS` — default `local-chrome`
- `CONTROL_PLANE_RUNTIME_API_KEY_FILE` — default `~/.config/chatgpt-browser-bridge/runtime-api-key`
- `BROWSERJACK_COMMAND` — default `scripts/browserjack-current.sh`
- `CHATGPT_APP_PATH` — default `/Applications/ChatGPT.app`
- `BROWSERJACK_PATCHED_ROOT` — override the prepared BrowserJack runtime path

The bridge waits until `tunnel-client` reports the managed runtime as running, healthy, and ready.

### Keep Local Chrome running

After the first connection succeeds, install the user-level macOS LaunchAgent:

```bash
bash scripts/service.sh install
```

The installer reuses the existing `local-chrome` profile and runtime-key file. It stops the manually managed runtime before loading launchd, then waits for the replacement process to become running, healthy, and ready. The LaunchAgent starts at login and restarts `tunnel-client` if the process exits. This whole-stack restart is also how a compatible ChatGPT app generation change gets a fresh stdio MCP session after validation; a manual non-launchd connection must be started again by the user.

The service runs the checked-in `tunnel-client-current.sh` launcher. It requires tunnel-client `0.0.13` and enables `MCP_STDIO_SEND_INITIALIZED_NOTIFICATION=true`, the upstream opt-in that completes a hosted stdio initialization when ChatGPT omits `notifications/initialized` and suppresses a later duplicate.

Do not run `connect-tunnel.sh` after persistence is installed. launchd must be the only owner of the tunnel process; use the service commands below instead. If you used a custom `TUNNEL_ALIAS`, `TUNNEL_CLIENT_PROFILE_DIR`, or `CONTROL_PLANE_RUNTIME_API_KEY_FILE`, pass the same override when installing or operating the service.

This is a per-user service. Local Chrome is unavailable while the Mac is powered off, logged out, asleep without network access, or unable to reach OpenAI over outbound HTTPS.

### Hosted `server/discover` compatibility

[OpenAI tunnel-client issue #41](https://github.com/openai/tunnel-client/issues/41) tracks a hosted ChatGPT compatibility problem with legacy MCP servers. This repository includes an opt-in wrapper that immediately rejects `server/discover` with JSON-RPC `-32601` and forwards every other MCP message unchanged.

Use the wrapper for the hosted ChatGPT legacy-stdio compatibility path:

```bash
CONTROL_PLANE_TUNNEL_ID=tunnel_... \
BROWSERJACK_COMMAND="$PWD/scripts/browserjack-discovery-compat.mjs" \
bash scripts/connect-tunnel.sh
```

The direct BrowserJack launcher remains the default for local use. Hosted ChatGPT acceptance for build `26.825.51511` (`7377`) on August 30, 2026 used official tunnel-client `0.0.13`, the initialized-notification compatibility opt-in, the stable `8ee11377-compat-v1` adapter, this discovery wrapper, and Chat mode. ChatGPT completed the real Chrome tool call and returned `Example Domain` without a response-deadline or client-internal `502` event. The wrapper deliberately does not deduplicate initialization; an earlier accepted trace received two harmless hosted `initialize` requests before `notifications/initialized` and `tools/list`.

## 4. Connect it in ChatGPT

In ChatGPT:

1. Open **Plugins → Create app**.
2. Name it something like **Local Chrome**.
3. Choose **Tunnel** as the connection type.
4. Select the tunnel you provisioned above.
5. Choose **No Auth** for the MCP app itself.
6. Accept the custom-MCP warning and create/connect the app.

Smoke test:

```text
Use Local Chrome to navigate my existing Chrome to https://example.com and return the page title.
```

Expected title: `Example Domain`.

## Watch it working

Follow the tunnel log in another terminal:

```bash
tail -f "$HOME/Library/Application Support/tunnel-client/logs/local-chrome.log"
```

Validate the local BrowserJack handshake and managed runtime:

```bash
bash scripts/status.sh
```

This also fails closed unless tunnel-client is exactly `0.0.13` and reports the initialized-notification compatibility mode enabled.

Run the direct MCP/Chrome smoke test:

```bash
node scripts/browserjack-mcp-smoke.mjs
```

Inspect the persistent service:

```bash
bash scripts/service.sh status
```

Restart it under launchd:

```bash
bash scripts/service.sh restart
```

Temporarily pause it for the current login session:

```bash
bash scripts/stop.sh
```

Resume it:

```bash
bash scripts/service.sh start
```

Disable it across future logins, then stop it:

```bash
launchctl disable "gui/$(id -u)/com.kapunakap.chatgpt-chrome-bridge.local-chrome"
bash scripts/service.sh stop
```

Re-enable and start it:

```bash
launchctl enable "gui/$(id -u)/com.kapunakap.chatgpt-chrome-bridge.local-chrome"
bash scripts/service.sh start
```

Uninstall only the LaunchAgent while preserving the tunnel profile, runtime-key file, and logs:

```bash
bash scripts/service.sh uninstall
```

The tunnel log remains at:

```text
~/Library/Application Support/tunnel-client/logs/local-chrome.log
```

LaunchAgent stdout and stderr are private mode-`600` files under:

```text
~/Library/Application Support/chatgpt-browser-bridge/launchd/
```

After moving this repository, uninstall the service from the old checkout, reconnect once from the new checkout so the profile points at the new BrowserJack launcher, then install the service again. To refresh the supported tunnel-client version, run `bash scripts/bootstrap-local.sh`, then rerun `bash scripts/service.sh install` so launchd uses the checked-in version guard and compatibility environment.

## Security

This bridge gives a remote AI client control of a browser that may already be authenticated to sensitive sites. Treat access to the ChatGPT app/workspace connection as equivalent to access to those browser sessions, and assume webpage content can attempt prompt injection.

The runtime API key stays in a local file and is passed to `tunnel-client` by file reference. The compatibility launcher checks the fixed OpenAI/Chrome identities plus approved browser-client, browser-service, and native-host hashes before starting. Every new app build then passes BrowserJack's one-time live self-test. See [SECURITY.md](SECURITY.md) for the full trust boundary and reporting guidance.

## Source projects

- [BrowserJack](https://github.com/stickerdaniel/browserjack)
- [OpenAI tunnel-client](https://github.com/openai/tunnel-client)
- [OpenAI Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

## License

MIT. See [LICENSE](LICENSE).
