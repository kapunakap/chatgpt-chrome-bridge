# chatgpt-browser-bridge

Bridge ChatGPT web to the existing signed-in Chrome on this Mac by reusing OpenAI's installed Codex browser runtime.

## Architecture

```text
ChatGPT web
  -> OpenAI Secure MCP Tunnel
  -> tunnel-client on this Mac
  -> BrowserJack stdio MCP
  -> OpenAI Codex browser runtime
  -> ChatGPT/Codex Chrome extension + native host
  -> existing signed-in Chrome
```

There is deliberately no public inbound port, custom reverse proxy, Browserbase session, second browser-automation extension, or fork of BrowserJack.

## Source of truth

- BrowserJack: https://github.com/stickerdaniel/browserjack
- OpenAI tunnel-client: https://github.com/openai/tunnel-client
- Tunnel end-user guide: https://github.com/openai/tunnel-client/blob/master/docs/end-user-guide.md
- OpenAI MCP developer-mode availability: https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt

BrowserJack is pinned in this repo because it depends on undocumented OpenAI interfaces and compatibility is build-sensitive. `tunnel-client` is installed from OpenAI's official Homebrew tap.

## Responsibilities

### ChatGPT

Owns architecture, upstream research, scripts/configuration, security decisions, validation criteria, and diagnosis. Changes to this repo should come from ChatGPT unless a local-machine observation proves a change is needed.

### Codex

Acts as remote hands on the Mac. It should clone/pull this repo, run the provided scripts exactly, perform local installs, open authentication/setup pages when needed, and report outputs. It should not redesign the stack or substitute other browser/MCP products.

### Human

Handles account authentication, creation/pasting of secrets, and product/workspace permission decisions that cannot safely be automated.

See `AGENTS.md` for the execution contract.

## Prerequisites

- macOS on Apple Silicon
- official ChatGPT.app
- ChatGPT/Codex Chrome extension already connected to the browser profile you want to control
- Homebrew
- Node.js 22+
- access to OpenAI Platform Tunnels and a runtime API key with Tunnels **Read + Use**

The bootstrap script verifies the local prerequisites rather than silently switching architecture.

## 1. Bootstrap the local browser bridge

```bash
./scripts/bootstrap-local.sh
```

This installs/validates:

1. BrowserJack `0.3.0` in runtime-only/plugin mode (no Claude registration)
2. the stable BrowserJack shim at `~/Library/Application Support/browserjack/bin/browserjack`
3. `browserjack doctor --live`
4. OpenAI `tunnel-client` from `openai/tools/tunnel-client`

A successful BrowserJack live doctor is the local proof that the OpenAI browser runtime can actually handshake with the existing browser.

## 2. Obtain the two OpenAI values

Create/inspect a tunnel at:

https://platform.openai.com/settings/organization/tunnels

Create a **Restricted** runtime API key with Tunnels **Read + Use** at:

https://platform.openai.com/settings/organization/api-keys

You need:

- `CONTROL_PLANE_TUNNEL_ID` — the `tunnel_...` identifier
- `CONTROL_PLANE_API_KEY` — runtime key, not an admin key

Do not put either secret value in this repository. The tunnel ID is not secret, but keeping machine/account-specific state out of git makes the repo reusable.

## 3. Connect the managed runtime

In the shell where the runtime key is available:

```bash
export CONTROL_PLANE_TUNNEL_ID='tunnel_...'
export CONTROL_PLANE_API_KEY='...'
./scripts/connect-tunnel.sh
```

The script uses OpenAI's supported managed-runtime path:

```text
tunnel-client runtimes connect
```

and binds its local stdio MCP target to the stable BrowserJack shim with `browserjack run`. It does not use `nohup`, `disown`, ngrok, Cloudflare, Tailscale, or an inbound listener.

The runtime key is passed as the secret reference `env:CONTROL_PLANE_API_KEY`; it is not copied into repo files or command output by our scripts.

## 4. Validate

```bash
./scripts/status.sh
```

Success requires both layers:

- BrowserJack status is healthy and `doctor --live` passes.
- `tunnel-client runtimes status` reports the managed runtime running, healthy, and ready.

Do not call the setup successful just because a process exists.

## 5. Connect it in ChatGPT

Once the local runtime is ready, open:

https://chatgpt.com/#settings/Connectors

Choose **Connection: Tunnel** and select/paste the same tunnel ID. Scan the MCP tools if the product asks you to do so.

Final smoke test from ChatGPT:

1. invoke BrowserJack against `https://example.com`
2. return the page title (`Example Domain`)
3. perform one harmless browser interaction

## Important entitlement gate

A healthy tunnel only proves transport and MCP readiness. It does not guarantee that a ChatGPT plan/workspace permits an action-capable custom MCP.

OpenAI's current help documentation says full MCP support including write/modify actions is available to Business and Enterprise/Edu, while Pro custom MCP access is limited to read/fetch. BrowserJack exposes a persistent `node_repl`, so if the ChatGPT workspace only permits read/fetch, expect browser clicks/typing to be blocked even though the local tunnel is healthy.

Treat that as a product entitlement issue, not a reason to replace BrowserJack or the tunnel architecture.

## Operations

```bash
# full status
./scripts/status.sh

# stop the managed tunnel runtime
./scripts/stop.sh

# reconnect after stopping
export CONTROL_PLANE_TUNNEL_ID='tunnel_...'
export CONTROL_PLANE_API_KEY='...'
./scripts/connect-tunnel.sh

# BrowserJack diagnostics only
"$HOME/Library/Application Support/browserjack/bin/browserjack" doctor --live --json

# tunnel runtime status only
tunnel-client runtimes --json status chatgpt-browser
```

## Security notes

This bridge intentionally gives an AI tool access to an already-authenticated browser. Treat the MCP as highly privileged.

- Never commit API keys, cookies, exported browser state, or support bundles containing secrets.
- Do not expose BrowserJack or its MCP over a public inbound port.
- BrowserJack relies on undocumented OpenAI interfaces and can stop working after a ChatGPT.app update; rerun `doctor --live` before changing architecture.
- Browser content can contain prompt-injection text. Prefer explicit, scoped browser tasks and confirmation for consequential actions.
