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

The current bridge is pinned to one verified OpenAI desktop build. Before it launches the compatibility BrowserJack runtime, it checks:

- exact app version and build
- bundle ID
- OpenAI TeamIdentifier
- exact browser-client SHA-256
- expected Chrome native-host name
- expected Chrome extension ID

The prepared BrowserJack checkout retains BrowserJack's cache/browser-client integrity checks. The narrow local patch exists because BrowserJack 0.3.0 does not understand the tested OpenAI build's current signing/layout behavior. The patch does not modify or redistribute OpenAI binaries.

Any unknown build or identity mismatch must fail closed until reviewed. Do not solve compatibility failures by globally disabling signature or identity checks.

## Network boundary

`tunnel-client` uses outbound HTTPS to OpenAI; this repository does not require a public inbound listener, reverse proxy, or firewall hole. The MCP server itself is launched locally by the managed tunnel runtime over stdio.

## Vulnerability reports

Prefer GitHub's private vulnerability reporting / Security Advisory flow for this repository. Do not include live credentials, cookies, browser profiles, or other secrets in a public issue.

For ordinary non-sensitive bugs, open a normal GitHub issue with the smallest reproducible diagnostic output and redact usernames or other machine-specific paths when they are not relevant.
