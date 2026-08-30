# Security

## Security boundary

`chatgpt-chrome-bridge` intentionally exposes control of an existing signed-in Chrome session to ChatGPT through OpenAI Secure MCP Tunnel. That is a powerful trust boundary: a connected AI client can act with whatever browser sessions and website permissions are already present in that Chrome profile.

Use a dedicated ChatGPT workspace/app connection you trust. Treat webpage content as untrusted input because prompt injection can influence browser-driving agents.

## Local secrets

The OpenAI tunnel runtime API key must stay outside the repository in a file owned by the current user with mode `600`. The checked-in scripts pass the key to `tunnel-client` by file reference and do not intentionally read or print the key value.

Never commit or publish:

- runtime or control-plane API keys
- cookies or browser-profile data
- tunnel support bundles or logs containing authentication material
- machine authentication state
- `.env` files or copied credential files

If a credential is accidentally exposed, revoke/rotate it before doing anything else; deleting it from the latest commit is not sufficient once it has been published.

## Compatibility trust checks

The bridge separates browser-runtime trust from app-build compatibility. Before it launches the compatibility BrowserJack runtime, it checks:

- bundle ID
- OpenAI TeamIdentifier
- exact browser-client SHA-256
- exact browser-service SHA-256
- exact installed and bundled Chrome native-host SHA-256, which must match each other
- expected Chrome native-host name
- expected Chrome extension ID

An app version or build number is not itself a trust boundary. When all approved identities and component hashes are unchanged, BrowserJack performs a one-time live self-test for the exact app version, build, plugin version, architecture, and browser-client hash. Failed self-tests are not recorded.

Changed component hashes remain blocked until `scripts/review-browserjack-update.sh` stages the exact candidate, passes the live doctor and direct Chrome smoke test, and writes a user-owned mode-`600` local approval. Identity changes cannot be approved by that command and require a checked-in review. The local approval file contains hashes and build metadata only.

The prepared BrowserJack checkout retains BrowserJack's cache/browser-client integrity checks. The narrow local patch exists because BrowserJack 0.3.0 does not understand the tested OpenAI build's current signing/layout behavior. The patch does not modify or redistribute OpenAI binaries.

Any unknown hash or identity mismatch must fail closed until reviewed. Do not solve compatibility failures by globally disabling signature, identity, fingerprint, or self-test checks.

## Network boundary

`tunnel-client` uses outbound HTTPS to OpenAI; this repository does not require a public inbound listener, reverse proxy, or firewall hole. The MCP server itself is launched locally by the managed tunnel runtime over stdio.

## Vulnerability reports

Prefer GitHub's private vulnerability reporting / Security Advisory flow for this repository. Do not include live credentials, cookies, browser profiles, or other secrets in a public issue.

For ordinary non-sensitive bugs, open a normal GitHub issue with the smallest reproducible diagnostic output and redact usernames or other machine-specific paths when they are not relevant.
