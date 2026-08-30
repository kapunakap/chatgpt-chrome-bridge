# AGENTS.md

Read `README.md` and `SECURITY.md` before changing this repository.

## Project constraints

1. Keep the architecture narrow: ChatGPT -> OpenAI Secure MCP Tunnel -> local `tunnel-client` -> BrowserJack -> the existing OpenAI browser runtime -> the user's existing Chrome.
2. Do not add a public inbound port, reverse proxy, hosted browser, or extra browser extension unless the user explicitly changes the architecture.
3. Never commit API keys, cookies, browser profiles, tunnel support bundles, logs, machine authentication state, or concrete user tunnel IDs.
4. Keep compatibility checks fail-closed. A new app version/build may self-test automatically only when its approved browser-runtime fingerprint and fixed identities match. Unknown hashes, native hosts, or extension identities must fail until explicitly reviewed.
5. Browser-runtime trust is centralized in `scripts/browserjack-trust.json`. Change its identities, hashes, pinned BrowserJack commit, or adapter ID only from concrete local evidence; never add version/build gates back to the launchers.
6. Do not modify or redistribute OpenAI binaries, the ChatGPT/Codex app bundle, Chrome, its profile, or the OpenAI Chrome extension.
7. Prefer checked-in scripts over ad-hoc command sequences.
8. Do not declare local success until `bash scripts/status.sh` passes and the managed tunnel reports running + healthy + ready.

## Static checks

Before proposing a change:

```bash
bash -n scripts/*.sh
node --check scripts/browserjack-mcp-smoke.mjs
node --check scripts/browserjack-fingerprint.mjs
node --test scripts/browserjack-fingerprint.test.mjs
```

For compatibility changes, also run the live BrowserJack doctor and the direct MCP/Chrome smoke test documented in `README.md`.
