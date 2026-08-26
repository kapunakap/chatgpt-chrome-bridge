# chatgpt-browser-bridge
<img width="1672" height="941" alt="ChatGPT Image Aug 27, 2026, 01_50_55 AM" src="https://github.com/user-attachments/assets/6ddbd299-ef4a-4fad-941b-7b3864252e3d" />

Bridges ChatGPT to the existing signed-in Chrome on this Mac through OpenAI's Secure MCP Tunnel and BrowserJack.

## Current status

`Local Chrome` is installed and locally verified:

- tunnel alias: `local-chrome`
- tunnel ID: `tunnel_6a8d22f3a68c81918cac74c9d23f183c`
- BrowserJack command: `/Users/onin/dev/chatgpt-browser-bridge/scripts/browserjack-current.sh run`
- durable BrowserJack runtime: `~/Library/Application Support/chatgpt-browser-bridge/browserjack/26.818.61809`
- runtime API key reference: `file:/Users/onin/.config/chatgpt-browser-bridge/runtime-api-key`

The key file is machine-local, must be owned by the current user, and must have mode `600`. Scripts never read or print its contents.

## Architecture

```text
ChatGPT web
  -> OpenAI Secure MCP Tunnel "Local Chrome"
  -> tunnel-client managed runtime on this Mac
  -> BrowserJack stdio MCP
  -> OpenAI Codex browser runtime
  -> ChatGPT/Codex Chrome extension + native host
  -> existing signed-in Chrome
```

There is no public inbound port, reverse proxy, extra browser extension, or hosted browser.

## Operations

Start or reconnect the managed runtime:

```bash
bash scripts/connect-tunnel.sh
```

Validate BrowserJack and require the runtime to be running, healthy, and ready:

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

The scripts accept `TUNNEL_ALIAS`, `CONTROL_PLANE_TUNNEL_ID`, `CONTROL_PLANE_RUNTIME_API_KEY_FILE`, and `BROWSERJACK_COMMAND` overrides. Defaults point to the verified `Local Chrome` setup above.

## ChatGPT setup

In ChatGPT, open **Plugins → Create app** and use:

- Name: `Local Chrome`
- Connection: `Tunnel`
- Available tunnel: `local-chrome (tunnel_6a8d22f3a68c81918cac74c9d23f183c)`
- Authentication: `No Auth`

Accept the custom-MCP warning, create the plugin, and scan/connect its tools if requested.

Final smoke request:

> Use Local Chrome to navigate my existing Chrome to https://example.com and return the page title.

Expected title: `Example Domain`.

## Compatibility and trust

BrowserJack 0.3.0 predates the browser runtime in ChatGPT/Codex app `26.818.61809` build `7019`. The local adapter is deliberately fail-closed to this exact observed runtime:

- bundle ID `com.openai.codex`
- OpenAI TeamIdentifier `2DC432GLL2`
- browser-client SHA-256 `53484b46feddd277e436a0c3f38820eca8aab4e32c01bb44e1b5766eb369b5e6`
- native host `com.openai.codexextension`
- Chrome extension ID `hehggadaopoacecdllhhajmbjkdcmajg`
- trusted service `browser-service.mjs` inside the verified Chrome plugin root

The adapter preserves BrowserJack's app/cache byte-integrity and native-host identity checks. It does not modify or re-sign ChatGPT.app, Chrome, the extension, or the Chrome profile. An app update or hash change fails closed and requires a new review.

## Source projects

- BrowserJack: https://github.com/stickerdaniel/browserjack
- OpenAI tunnel-client: https://github.com/openai/tunnel-client
- OpenAI Secure MCP Tunnel guide: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

Never commit API keys, cookies, browser profiles, tunnel profiles, logs, or machine authentication state.
