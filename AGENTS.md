# AGENTS.md

Read `README.md` and `SECURITY.md` before changing this repository.

## Project constraints

1. Keep the architecture narrow: ChatGPT -> OpenAI Secure MCP Tunnel -> local `tunnel-client` -> BrowserJack -> the existing OpenAI browser runtime -> the user's existing Chrome.
2. Do not add a public inbound port, reverse proxy, hosted browser, or extra browser extension unless the user explicitly changes the architecture.
3. Never commit API keys, cookies, browser profiles, tunnel support bundles, logs, machine authentication state, or concrete user tunnel IDs.
4. Keep compatibility checks fail-closed. Unknown ChatGPT/Codex builds, hashes, native hosts, or extension identities must fail until explicitly reviewed.
5. The tested-build constants in `scripts/prepare-browserjack.sh` and `scripts/browserjack-current.sh` are a matched set. Change them only from concrete local evidence and update both files together.
6. Do not modify or redistribute OpenAI binaries, the ChatGPT/Codex app bundle, Chrome, its profile, or the OpenAI Chrome extension.
7. Prefer checked-in scripts over ad-hoc command sequences.
8. Do not declare local success until `bash scripts/status.sh` passes and the managed tunnel reports running + healthy + ready.

## Static checks

Before proposing a change:

```bash
bash -n scripts/*.sh
node --check scripts/browserjack-mcp-smoke.mjs
```

For compatibility changes, also run the live BrowserJack doctor and the direct MCP/Chrome smoke test documented in `README.md`.
