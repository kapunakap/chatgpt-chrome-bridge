# Browserbase hosted fallback

This is the temporary cloud-browser path while the preferred local BrowserJack path is blocked by the OpenAI macOS signing regression documented in `KNOWN_BLOCKER.md`.

## Architecture

```text
ChatGPT web
  -> Browserbase hosted MCP (Streamable HTTP)
  -> Browserbase cloud Chromium
  -> target website
```

This does **not** control the Chrome profile on this Mac. Browserbase sessions are isolated cloud browsers.

## Why hosted MCP

Browserbase currently recommends its hosted Streamable HTTP endpoint for most users:

```text
https://mcp.browserbase.com/mcp
```

The hosted endpoint needs only a Browserbase API key for normal use. A Browserbase project ID is not required by the hosted MCP configuration. Stagehand defaults to Browserbase's hosted `google/gemini-2.5-flash-lite`, so no separate model key is required unless we deliberately override the model.

Source of truth:

- https://docs.browserbase.com/integrations/mcp/introduction
- https://docs.browserbase.com/integrations/mcp/setup
- https://www.browserbase.com/mcp

Do not use the archived `browserbase/mcp-server-browserbase` repository as the production source of truth; Browserbase keeps it only as a historical/self-hosted reference.

## Credentials

Get `BROWSERBASE_API_KEY` from the Browserbase dashboard:

https://www.browserbase.com/overview

Never commit it to this repository.

Browserbase's hosted MCP authenticates with the API key as the `browserbaseApiKey` query parameter. The effective endpoint is therefore:

```text
https://mcp.browserbase.com/mcp?browserbaseApiKey=<API_KEY>
```

Optional hosted query parameters we may use later:

- `keepAlive=true` — keep the Browserbase session alive after MCP transport disconnects
- `proxies=true`
- `verified=true` — Browserbase Verified, plan-dependent
- `modelName=...` + `modelApiKey=...` — only if overriding the default Stagehand model

For the temporary ChatGPT fallback, use `keepAlive=true` so a transient ChatGPT MCP transport disconnect does not immediately destroy the browser session.

## Local credential/MCP smoke test

After setting the key in the shell:

```bash
export BROWSERBASE_API_KEY='...'
python3 scripts/browserbase-mcp-smoke.py
```

The default smoke test performs only MCP initialization and `tools/list`; it does **not** create a browser session.

To verify an actual Browserbase browser can start, and then immediately close it:

```bash
python3 scripts/browserbase-mcp-smoke.py --start
```

That test is intentionally opt-in because Browserbase sessions are billable resources.

## Add Browserbase to ChatGPT

Browserbase's hosted MCP is already remote, so Secure MCP Tunnel is not involved.

In ChatGPT web:

1. Enable Developer mode if the account/workspace supports custom apps.
2. Go to **Settings -> Apps -> Create** (wording may vary by workspace).
3. Create a custom app named `Browserbase`.
4. Use this MCP endpoint, substituting the real key locally in the UI:

   ```text
   https://mcp.browserbase.com/mcp?browserbaseApiKey=<API_KEY>&keepAlive=true
   ```

5. Scan tools.
6. Expected current hosted tools are:
   - `start`
   - `end`
   - `navigate`
   - `act`
   - `observe`
   - `extract`
7. Save/enable the app if ChatGPT permits the tool permissions.

Do not put the API-key-bearing endpoint in GitHub issues, commits, screenshots, or chat messages.

## ChatGPT session rule

Browserbase documents a ChatGPT-specific transport behavior: ChatGPT may not preserve the same MCP transport/session header between tool calls.

Therefore the reliable call pattern is:

1. call `start`
2. save the returned Browserbase `sessionId`
3. pass that **same explicit `sessionId` on every later call**:
   - `navigate`
   - `act`
   - `observe`
   - `extract`
   - `end`

Do not rely on Browserbase's implicit "current active session" when using ChatGPT.

Example logical sequence:

```text
start() -> sessionId=abc
navigate(url="https://example.com", sessionId="abc")
extract(instruction="main heading", sessionId="abc")
end(sessionId="abc")
```

## First smoke test in ChatGPT

Ask ChatGPT to:

1. start a Browserbase session
2. navigate to `https://example.com` using the returned `sessionId`
3. extract the main heading using that same `sessionId`
4. end that session explicitly

Expected extracted heading: `Example Domain`.

## Important ChatGPT entitlement gate

Browserbase exposes real browser actions (`navigate`, `act`, session lifecycle, etc.). OpenAI's current documentation says full action-capable custom MCP support is available to ChatGPT Business and Enterprise/Edu, while Pro custom MCP connections are limited to read/fetch permissions.

So there are two separate success gates:

1. **Browserbase MCP works** — the endpoint initializes and exposes tools.
2. **This ChatGPT workspace permits those action tools** — a product-plan/workspace entitlement outside Browserbase.

If ChatGPT scans the tools but refuses to enable/invoke browser actions, do not debug Browserbase or add a tunnel. Treat that as the ChatGPT entitlement boundary.

## Authentication to websites

A Browserbase cloud browser is initially separate from this Mac's signed-in Chrome profile.

For a one-off temporary session, use Browserbase Live View / normal browser interaction to sign in and keep the same Browserbase `sessionId` alive.

For durable authentication across new Browserbase sessions, Browserbase Contexts are the correct primitive. The hosted MCP's current public query parameters do not expose `contextId`; `--contextId` is documented for the locally run Browserbase MCP package. If we later need durable login persistence, design that separately rather than embedding credentials into prompts or scripts.

## Security / cost

- Treat the Browserbase API key as a secret.
- Explicitly `end` sessions when finished.
- Browser sessions can incur usage charges; avoid agent loops that repeatedly call `start`.
- A cloud browser can encounter prompt injection on webpages. Keep consequential actions scoped and confirmed.
- Do not use Browserbase as justification to weaken or bypass the local BrowserJack signing checks.
