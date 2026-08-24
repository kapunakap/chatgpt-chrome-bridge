# Known blocker: OpenAI macOS signing regression

Status: **blocked upstream** as of 2026-08-24.

The locally installed official OpenAI desktop app cannot currently be used as BrowserJack's trust anchor because macOS strict code-signature verification fails for the app and the executable components BrowserJack would launch or trust.

Observed build:

- app version: `26.818.61809`
- build: `7019`
- bundle id: `com.openai.codex`
- OpenAI TeamIdentifier reported: `2DC432GLL2`
- `Authority=(unavailable)` on the failing signatures

Strict verification failed for:

- `/Applications/ChatGPT.app`
- `Contents/Resources/codex`
- `Contents/Resources/cua_node/bin/node`
- `Contents/Resources/cua_node/bin/node_repl`
- `Contents/Resources/native/browser-use-peer-authorization.node`
- `Contents/Resources/codex-code-mode-host`
- bundled Chrome native host `ChatGPT for Chrome`
- cached/installed Chrome native host `ChatGPT for Chrome`

The app-bundled and cached `browser-client.mjs` files are byte-for-byte identical, so this is not explained by a divergent writable plugin cache.

Relevant upstream reports:

- https://github.com/openai/codex/issues/40025 — official production DMG reproduced with invalid signatures on the preceding 26.818 build
- https://github.com/openai/codex/issues/40407 — same `26.818.61809` app version reports Chrome control failing with `Invalid signature` on macOS

## Security decision

Do **not** work around this by ad-hoc re-signing, disabling signature checks, copying binaries, patching BrowserJack to trust invalid code, or launching the tunnel anyway.

This bridge intentionally exposes an authenticated browser to a remote AI client. BrowserJack's OpenAI code-signature checks are a meaningful trust boundary and stay mandatory.

## Separate compatibility issue

BrowserJack 0.3.0 also expects `plugins/openai-bundled/plugins/chrome/scripts/extension-id.json`, which this app build no longer ships. The installed Chrome native-host manifest contains enough metadata to derive the native-host name and allowed extension IDs, so this layout change appears adaptable once the OpenAI signing issue is fixed.

Do not spend Codex time on the layout adaptation while the signing trust boundary is failing.

## Resume criterion

Resume implementation only after an installed official OpenAI desktop build passes:

```bash
/usr/bin/codesign --verify --strict /Applications/ChatGPT.app
```

Then rerun:

```bash
bash scripts/diagnose-signing.sh
bash scripts/bootstrap-local.sh
```

If signature verification is clean but BrowserJack still fails on the missing `extension-id.json`, adapt the metadata discovery at that point without weakening any signing checks.
