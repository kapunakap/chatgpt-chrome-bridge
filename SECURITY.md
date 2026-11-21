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

Changed component hashes remain blocked from serving until a signed candidate path passes the real live doctor. The long-lived launcher then writes only that exact candidate fingerprint to the user-owned mode-`600` local approval file after success; `scripts/review-browserjack-update.sh` remains available for an explicit review that also runs the direct Chrome smoke test. Identity changes cannot be approved by these runtime paths and require a checked-in review. The local approval file contains hashes and build metadata only.

After a new signed generation passes these checks, the supervisor exits instead of replacing BrowserJack inside the existing process-affine tunnel stdio session. `tunnel-client` shuts down when the MCP child closes, and launchd `KeepAlive` starts a fresh tunnel-client and BrowserJack stack. A rejected generation stays in the existing blocked supervisor and returns unavailable errors; it does not repeatedly exit into a launchd restart loop. Same-generation transient child failures may still recover BrowserJack in-process.

The prepared adapter and bridge-owned BrowserJack verified-build cache live under `${CODEX_HOME:-$HOME/.codex}/chatgpt-browser-bridge/browserjack` because the OpenAI Browser sandbox allows writes under `CODEX_HOME`. Launchd logs and unrelated outer state remain unchanged.

The prepared BrowserJack checkout retains BrowserJack's cache/browser-client integrity checks. The narrow local patch exists because BrowserJack 0.3.0 does not understand the tested OpenAI build's current signing/layout behavior. The patch does not modify or redistribute OpenAI binaries.

Any unknown hash or identity mismatch must fail closed until the signed candidate has passed its allowed compatibility test; identity mismatches remain blocked. Do not solve compatibility failures by globally disabling signature, identity, fingerprint, or self-test checks.

Historical v2 catalogue entries are not executable-path authority for a newer signed app. When there is no entry for the current app, direct app resolution uses only contained, signed-bundle runtime components and the already verified installed native host. Malformed catalogues and invalid or ambiguous current entries remain blocked. No registration is manufactured or edited.

Service diagnostics use the existing LaunchAgent environment through a temporary one-shot launchd job. They do not forward Codex chat-scoped executor settings, mint an access identity, rewrite turn metadata to borrow a chat's access, or disable native pipe authorization. These checks run as independent service processes, under the same trust checks as the serving tunnel. Raw status output stays in a private temporary directory and is removed after the bounded check; only fixed readiness fields are printed.

## Network boundary

`tunnel-client` uses outbound HTTPS to OpenAI; this repository does not require a public inbound listener, reverse proxy, or firewall hole. The MCP server itself is launched locally by the managed tunnel runtime over stdio.

The running discovery wrapper exposes one current-user Unix socket for its fixed BrowserJack readiness probe. Its parent directory is mode `700`, the socket is mode `600`, stale sockets are removed only after confirming they are current-user Unix sockets with no live listener, and the socket is removed on shutdown. It accepts only `{"op":"probe"}` and does not accept caller-supplied JavaScript, MCP requests, browser content, URLs, or credentials. Probe responses are reduced to readiness booleans and a bounded failure class. The internal health request has no caller-supplied turn metadata, so BrowserJack applies its existing stable stdio-child session policy without the wrapper capturing, storing, persisting, echoing, or replaying any external session identifier. Its fixed JavaScript runs in a scoped async function, reuses the serving `globalThis.agent`, and never renames an existing serving browser session.

## Vulnerability reports

Prefer GitHub's private vulnerability reporting / Security Advisory flow for this repository. Do not include live credentials, cookies, browser profiles, or other secrets in a public issue.

For ordinary non-sensitive bugs, open a normal GitHub issue with the smallest reproducible diagnostic output and redact usernames or other machine-specific paths when they are not relevant.

## Experimental DevKit action socket

The separately opt-in `BROWSERJACK_DEVKIT_ACTIONS_ENABLED=true` LaunchAgent setting creates a **second**, private Unix socket in the same current-user directory, `devkit-actions.sock`. This socket shares the already-serving BrowserJack child and never launches a second browser profile or runtime. It validates socket ownership/modes, rejects arbitrary JavaScript, MCP payloads, localhost/intranet URLs, credentials, query strings, fragments, and unrecognized operations. The only requests are bounded `tabs_list`, `read` (one specified tab + verified origin), and `navigate` (new tab only). Native BrowserJack grants and verified signed runtime checks remain in force.

The socket is accessible to *other processes owned by the same macOS user*. It is **not** a replacement for local OS user isolation. DevKit applies a second security boundary before forwarding requests: a signed-in, device-scoped outbound agent, an explicit local user command granting a named HTTPS origin and access mode, a 15-minute in-memory lease cleared on reconnect, per-tab origin checks before and after reads, and filtering of all ungranted tabs before any response reaches DevKit Cloud. The bridge alone does not store DevKit account IDs or approvals and must not be advertised as a multi-user auth boundary.

Navigation responses are cached by request ID during one bridge process lifetime only. A lost response across a bridge restart is ambiguous and **must not** be retried automatically. The page snapshot is untrusted content; neither browser content nor prompts may escalate a local grant. Avoid sending credentials or private URLs to the bridge, ChatGPT, logs, or issues. This capability is **not approved for public DevKit distribution** solely because its local tests pass.

### Explicit DevKit session ownership

`BROWSERJACK_DEVKIT_SESSION_OWNER=devkit` is a separate experimental service opt-in
and requires the action-socket opt-in. The same tunnel-owned wrapper launches the
same verified `browserjack-current.sh` entry point and supervisor. The wrapper
performs an ordinary MCP handshake as its own client; upstream BrowserJack applies
its existing per-child metadata. No hosted `_meta`, session/turn IDs, credentials
or native authorization data enter the owned child. Unsupported client requests
are denied; no approval or credential interaction is handled automatically.

In this mode all hosted MCP input is rejected or discarded before reaching the
child, and internal child output is not sent to hosted stdout. The normal hosted
mode remains the default. Both updated wrapper modes claim a private current-user
owner file before launching, also refusing any live legacy health/action socket.
A dead lock is reclaimed only after validating its type, owner, mode, contents and
dead PID; changing file identity aborts cleanup. A short-lived private exclusive
claim guard serializes acquisition, recovery and release. An abandoned claim
guard fails closed and requires explicit inspection; it is not automatically
deleted. Neither mode stops or replaces a different live owner. Upgrade the
single managed wrapper in place; do not run old
and new launchers concurrently.

The owner readiness probe and action helper share one observed Chrome binding.
An absent or ambiguous browser fails closed. The health result contains only
readiness booleans, and no local origin permission is granted by initialization.
Host and native policy failures remain errors. This candidate has pure test
coverage only until the actual Mac and ChatGPT integration checks pass.

Both private servers track their own active connections and destroy those
connections during shutdown before releasing the owner. Health request input has
a bounded one-second deadline. An unfinished half-open client cannot retain the
wrapper or its owner lock after the child exits. This cleanup never signals or
closes resources belonging to another bridge owner.
