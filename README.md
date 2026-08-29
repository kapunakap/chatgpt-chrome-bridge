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

## Current compatibility

The bridge is deliberately fail-closed to the OpenAI desktop build it has been verified against:

- app version: `26.825.32147`
- build: `7303`
- bundle ID: `com.openai.codex`
- OpenAI TeamIdentifier: `2DC432GLL2`
- browser-client SHA-256: `c52ba09202f0e82caa6f6d2a6463a8635c1b1316567975d9b91c1a05fb5af501`
- Chrome native host: `com.openai.codexextension`
- Chrome extension ID: `hehggadaopoacecdllhhajmbjkdcmajg`

Any mismatch fails closed. ChatGPT/Codex desktop updates can therefore require a compatibility review before this bridge works again.

BrowserJack 0.3.0 does not understand the current OpenAI desktop layout/signing behavior used by this tested build. `scripts/prepare-browserjack.sh` builds a pinned BrowserJack checkout with the narrow compatibility adaptation used by this project and makes the live doctor require a real Chrome backend. The tested build continues to run BrowserJack inside its restricted outer Codex sandbox. No OpenAI binary, extension, browser profile, or app bundle is modified or redistributed.

## Requirements

- macOS on Apple Silicon
- official ChatGPT/Codex desktop app installed at `/Applications/ChatGPT.app`
- the official ChatGPT/Codex Chrome integration already installed and working in Chrome
- Homebrew
- Node.js 22+ (the bootstrap script installs Homebrew `node@22` when needed)
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
~/Library/Application Support/chatgpt-browser-bridge/browserjack/26.825.32147
```

It does not modify `ChatGPT.app`, Chrome, the OpenAI Chrome extension, or your browser profile.

## 3. Start the tunnel

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

### Temporary `server/discover` compatibility

[OpenAI tunnel-client issue #41](https://github.com/openai/tunnel-client/issues/41) tracks a hosted ChatGPT compatibility problem with legacy MCP servers. This repository includes an opt-in wrapper that immediately rejects `server/discover` with JSON-RPC `-32601` and forwards every other MCP message unchanged.

Use the wrapper only when testing that compatibility path:

```bash
CONTROL_PLANE_TUNNEL_ID=tunnel_... \
BROWSERJACK_COMMAND="$PWD/scripts/browserjack-discovery-compat.mjs" \
bash scripts/connect-tunnel.sh
```

The direct BrowserJack launcher remains the default. Hosted acceptance for build `26.825.32147` on August 29, 2026 used tunnel-client `0.0.12`, refreshed the plugin actions, and completed the `Example Domain` Chrome smoke test. An earlier hosted trace sent two `initialize` requests during refresh; both were forwarded and BrowserJack remained healthy, so the wrapper deliberately does not deduplicate initialization.

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

Run the direct MCP/Chrome smoke test:

```bash
node scripts/browserjack-mcp-smoke.mjs
```

Stop the managed runtime:

```bash
bash scripts/stop.sh
```

## Security

This bridge gives a remote AI client control of a browser that may already be authenticated to sensitive sites. Treat access to the ChatGPT app/workspace connection as equivalent to access to those browser sessions, and assume webpage content can attempt prompt injection.

The runtime API key stays in a local file and is passed to `tunnel-client` by file reference. The compatibility launcher checks the exact tested OpenAI app version/build, bundle ID, TeamIdentifier, browser-client hash, native-host identity, and extension identity before starting. See [SECURITY.md](SECURITY.md) for the full trust boundary and reporting guidance.

## Source projects

- [BrowserJack](https://github.com/stickerdaniel/browserjack)
- [OpenAI tunnel-client](https://github.com/openai/tunnel-client)
- [OpenAI Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

## License

MIT. See [LICENSE](LICENSE).
