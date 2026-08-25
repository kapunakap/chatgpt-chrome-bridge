# Status

## 2026-08-25 — LOCAL_CHROME_TUNNEL_READY

Verified local path:

```text
OpenAI Secure MCP Tunnel "Local Chrome"
-> tunnel-client 0.0.12 managed runtime
-> durable BrowserJack adapter
-> OpenAI Codex browser runtime
-> existing signed-in Chrome
```

Runtime configuration:

- alias: `local-chrome`
- tunnel ID: `tunnel_6a8d22f3a68c81918cac74c9d23f183c`
- MCP command: `"/Users/onin/dev/chatgpt-browser-bridge/scripts/browserjack-current.sh" run`
- runtime key reference: `file:/Users/onin/.config/chatgpt-browser-bridge/runtime-api-key`
- durable BrowserJack runtime: `/Users/onin/Library/Application Support/chatgpt-browser-bridge/browserjack/26.818.61809`

Evidence:

- BrowserJack tests: `58/58` pass
- BrowserJack live doctor: ready
- MCP initialize: pass
- MCP `js` tool discovery: pass
- Chrome backend discovery: pass
- Example Domain smoke test: title `Example Domain`
- tunnel process running: true
- tunnel healthy: true (`/healthz` returned `live`)
- tunnel ready: true (`/readyz` returned `ready`)
- authenticated remote tunnel lookup: pass, HTTP 200, no remote error
- control-plane poller: started; structured poll-health remains `unknown` because tunnel-client reports no live admin UI system snapshot

Remaining ChatGPT-side action:

1. In ChatGPT connector settings, select/connect the existing **Local Chrome** tunnel.
2. Ask it to navigate to `https://example.com` and return `Example Domain`.

No ChatGPT.app, Chrome extension/profile, global trust policy, or alternate browser architecture was modified.
