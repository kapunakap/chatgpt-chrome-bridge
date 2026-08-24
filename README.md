# chatgpt-browser-bridge

Primary goal: bridge ChatGPT web to the existing signed-in Chrome on this Mac by reusing OpenAI's installed Codex browser runtime.

> **Current local status — blocked upstream:** OpenAI desktop app `26.818.61809` build `7019` fails macOS strict code-signature verification for the app and the browser/runtime executables BrowserJack depends on. Do not bypass this trust check. See [`KNOWN_BLOCKER.md`](KNOWN_BLOCKER.md).
>
> **Temporary fallback:** Browserbase hosted MCP is prepared as a cloud-browser alternative. See [`BROWSERBASE.md`](BROWSERBASE.md). It does not control this Mac's Chrome profile.

## Preferred local architecture

```text
ChatGPT web
  -> OpenAI Secure MCP Tunnel
  -> tunnel-client on this Mac
  -> BrowserJack stdio MCP
  -> OpenAI Codex browser runtime
  -> ChatGPT/Codex Chrome extension + native host
  -> existing signed-in Chrome
```

There is deliberately no public inbound port, custom reverse proxy, second local browser-automation extension, or fork of BrowserJack.

## Temporary Browserbase architecture

```text
ChatGPT web
  -> Browserbase hosted MCP
  -> Browserbase cloud Chromium
  -> target website
```

Browserbase is a temporary fallback only; the preferred end state remains the local signed-in Chrome bridge.

## Source of truth

- BrowserJack: https://github.com/stickerdaniel/browserjack
- OpenAI tunnel-client: https://github.com/openai/tunnel-client
- Tunnel end-user guide: https://github.com/openai/tunnel-client/blob/master/docs/end-user-guide.md
- Browserbase MCP: https://docs.browserbase.com/integrations/mcp/setup
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

## Browserbase quick path

While the local path is blocked:

1. Follow [`BROWSERBASE.md`](BROWSERBASE.md).
2. Obtain `BROWSERBASE_API_KEY` from Browserbase.
3. Optionally validate the hosted MCP without creating a browser session:

```bash
export BROWSERBASE_API_KEY='...'
python3 scripts/browserbase-mcp-smoke.py
```

4. Add the Browserbase hosted MCP URL to ChatGPT as a custom app if the workspace permits it.

OpenAI currently documents full action-capable custom MCP support for Business and Enterprise/Edu, while Pro custom MCP access is limited to read/fetch. If Browserbase scans successfully but ChatGPT blocks `start`, `navigate`, or `act`, that is a ChatGPT entitlement boundary rather than a Browserbase transport failure.

## Local prerequisites

- macOS on Apple Silicon
- official ChatGPT.app
- ChatGPT/Codex Chrome extension already connected to the browser profile you want to control
- Homebrew
- Node.js 22+
- access to OpenAI Platform Tunnels and a runtime API key with Tunnels **Read + Use**

The bootstrap script verifies the local prerequisites rather than silently switching architecture.

## 1. Bootstrap the local browser bridge

```bash
bash scripts/bootstrap-local.sh
```

The first bootstrap gate is now strict verification of the OpenAI desktop app. If the installed app signature is invalid, bootstrap stops immediately with `BLOCKED_UPSTREAM_OPENAI_SIGNATURE`; it does not install, patch, or launch around that failure.

Once the signature gate passes, bootstrap installs/validates:

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
bash scripts/connect-tunnel.sh
```

The script uses OpenAI's supported managed-runtime path:

```text
tunnel-client runtimes connect
```

and binds its local stdio MCP target to the stable BrowserJack shim with `browserjack run`. It does not use `nohup`, `disown`, ngrok, Cloudflare, Tailscale, or an inbound listener.

The runtime key is passed as the secret reference `env:CONTROL_PLANE_API_KEY`; it is not copied into repo files or command output by our scripts.

## 4. Validate

```bash
bash scripts/status.sh
```

Success requires both layers:

- BrowserJack status is healthy and `doctor --live` passes.
- `tunnel-client runtimes status` reports the managed runtime running, healthy, and ready.

Do not call the setup successful just because a process exists.

## 5. Connect the local path in ChatGPT

Once the local runtime is ready, open:

https://chatgpt.com/#settings/Connectors

Choose **Connection: Tunnel** and select/paste the same tunnel ID. Scan the MCP tools if the product asks you to do so.

Final local-path smoke test from ChatGPT:

1. invoke BrowserJack against `https://example.com`
2. return the page title (`Example Domain`)
3. perform one harmless browser interaction

## Operations

```bash
# full local status
bash scripts/status.sh

# signing/layout diagnostics
bash scripts/diagnose-signing.sh
bash scripts/diagnose-chatgpt-bundle.sh

# Browserbase hosted MCP tool scan (requires env key; no browser created)
python3 scripts/browserbase-mcp-smoke.py

# stop the managed local tunnel runtime
bash scripts/stop.sh

# reconnect local path after stopping
export CONTROL_PLANE_TUNNEL_ID='tunnel_...'
export CONTROL_PLANE_API_KEY='...'
bash scripts/connect-tunnel.sh

# BrowserJack diagnostics only
"$HOME/Library/Application Support/browserjack/bin/browserjack" doctor --live --json

# tunnel runtime status only
tunnel-client runtimes --json status chatgpt-browser
```

## Security notes

Both architectures give an AI tool meaningful browser access. Treat the MCP as highly privileged.

- Never commit API keys, cookies, exported browser state, or support bundles containing secrets.
- Do not expose BrowserJack or its MCP over a public inbound port.
- Never weaken or bypass OpenAI code-signature verification to make BrowserJack start.
- Explicitly close Browserbase sessions when finished to limit cost and exposure.
- BrowserJack relies on undocumented OpenAI interfaces and can stop working after a ChatGPT.app update; rerun `doctor --live` before changing architecture.
- Browser content can contain prompt-injection text. Prefer explicit, scoped browser tasks and confirmation for consequential actions.
