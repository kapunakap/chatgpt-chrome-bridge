# Status

## 2026-08-24

**State: BLOCKED_UPSTREAM_OPENAI_SIGNATURE**

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

Decision: do not bypass signing checks, do not re-sign OpenAI binaries, do not create the MCP tunnel yet.

Resume when an official OpenAI desktop build passes `/usr/bin/codesign --verify --strict /Applications/ChatGPT.app`, then rerun the repository diagnostics and bootstrap.
