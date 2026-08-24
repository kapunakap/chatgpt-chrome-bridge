# Status

## 2026-08-25

### Temporary path: BROWSERBASE_HOSTED_MCP_PREPARED

The Browserbase cloud-browser fallback is now prepared in this repository while the preferred local BrowserJack path remains blocked.

Prepared:

- `BROWSERBASE.md` — hosted MCP architecture, ChatGPT setup, session handling, security/cost notes
- `scripts/browserbase-mcp-smoke.py` — secret-safe MCP initialize/tool-scan smoke test, with optional create-and-immediately-close browser session test
- hosted endpoint uses only `BROWSERBASE_API_KEY`; no Browserbase project ID or separate model key is required for the default hosted MCP
- use `keepAlive=true` for the temporary ChatGPT connection
- ChatGPT must pass the Browserbase `sessionId` returned by `start` explicitly on every later `navigate`, `act`, `observe`, `extract`, and `end` call because ChatGPT may use a fresh MCP transport between calls

Remaining human/account boundary:

1. obtain a Browserbase API key from the Browserbase dashboard
2. optionally run the local smoke test with that key
3. create/scan the Browserbase custom app in ChatGPT using the hosted MCP endpoint
4. observe whether the current ChatGPT workspace entitlement permits Browserbase's action tools

OpenAI currently documents full action-capable custom MCP support for Business and Enterprise/Edu, while Pro custom MCP access is limited to read/fetch. If ChatGPT scans Browserbase but blocks `start`/`navigate`/`act`, treat that as a ChatGPT entitlement boundary, not a Browserbase failure.

## 2026-08-24

### Preferred local path: BLOCKED_UPSTREAM_OPENAI_SIGNATURE

Local execution reached the BrowserJack bootstrap trust boundary and established:

- OpenAI desktop app version `26.818.61809`, build `7019`
- app bundle id `com.openai.codex`
- strict macOS code-signature verification fails for the app and all browser/runtime executables inspected
- all failing binaries still report OpenAI TeamIdentifier `2DC432GLL2`, but `Authority=(unavailable)`
- installed/cached Chrome native host also fails strict verification
- bundled and cached `browser-client.mjs` hashes match exactly
- BrowserJack 0.3.0 additionally expects a removed `scripts/extension-id.json`, but that compatibility issue is secondary while signing is broken
- OpenAI issue #40025 reproduces invalid signatures directly from the official production DMG on the preceding 26.818 build
- OpenAI issue #40407 reports the same `26.818.61809` version failing Chrome control with `Invalid signature`

Decision: do not bypass signing checks and do not re-sign OpenAI binaries.

Resume the local path when an official OpenAI desktop build passes `/usr/bin/codesign --verify --strict /Applications/ChatGPT.app`, then rerun the repository diagnostics and bootstrap.
