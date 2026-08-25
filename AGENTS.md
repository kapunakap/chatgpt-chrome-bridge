# AGENTS.md

This repository is intentionally small. ChatGPT owns architecture and diagnosis; Codex is the local execution layer.

## Codex contract

When working in this repo:

1. Read `README.md` first.
2. Do not replace BrowserJack, `tunnel-client`, or the architecture unless the user explicitly asks.
3. Do not fork BrowserJack or tunnel-client just to work around a local setup failure.
4. Prefer the checked-in scripts over hand-written command sequences.
5. Do not add ngrok, Cloudflare Tunnel, Tailscale, reverse proxies, inbound firewall rules, Browserbase, Playwright MCP, Browser MCP, or another browser extension.
6. Never commit secrets, cookies, browser profiles, API keys, tunnel support bundles, or machine-specific authentication state.
7. Never echo `CONTROL_PLANE_API_KEY` or put its value in command-line arguments, source files, logs, issues, commits, or chat output.
8. If a script fails, capture the command, exit code, and non-secret stdout/stderr. Do not improvise a new architecture.
9. If OpenAI account/workspace permissions or a browser authentication step blocks progress, stop at that boundary and report the exact UI/permission needed.
10. Do not declare success until `bash scripts/status.sh` passes and the tunnel runtime reports running + healthy + ready.

## Intended local flow

```bash
bash scripts/connect-tunnel.sh
bash scripts/status.sh
node scripts/browserjack-mcp-smoke.mjs
```

The checked-in defaults use the existing `Local Chrome` tunnel and the protected runtime-key file at `~/.config/chatgpt-browser-bridge/runtime-api-key`. Never read or print that file.

After local success, the remaining ChatGPT-side task is connector selection and an end-to-end BrowserJack smoke test.

## Changes to this repo

Only modify repository code when a concrete local observation demonstrates that a checked-in command is wrong for the installed upstream versions. Keep any fix narrow, cite the observed failure in the commit message, and report the diff back to ChatGPT for review.
