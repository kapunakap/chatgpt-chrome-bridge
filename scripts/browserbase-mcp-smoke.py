#!/usr/bin/env python3
"""Secret-safe smoke test for Browserbase's hosted MCP endpoint.

Default: initialize MCP and list tools only (no browser session created).
With --start: create one Browserbase session, verify a sessionId is returned,
and immediately close it.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

BASE_URL = "https://mcp.browserbase.com/mcp"
PROTOCOL_VERSION = "2025-06-18"
EXPECTED_TOOLS = {"start", "end", "navigate", "act", "observe", "extract"}


def fail(message: str, code: int = 1) -> "NoReturn":
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(code)


def parse_response(body: str, content_type: str) -> Any:
    if not body.strip():
        return None

    if "text/event-stream" not in content_type:
        return json.loads(body)

    # Streamable HTTP may return one or more SSE events. Parse each data block
    # and return the last JSON-RPC message.
    messages: list[Any] = []
    data_lines: list[str] = []
    for line in body.splitlines():
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
        elif not line.strip() and data_lines:
            raw = "\n".join(data_lines)
            data_lines.clear()
            try:
                messages.append(json.loads(raw))
            except json.JSONDecodeError:
                pass
    if data_lines:
        try:
            messages.append(json.loads("\n".join(data_lines)))
        except json.JSONDecodeError:
            pass

    if not messages:
        raise ValueError("SSE response contained no JSON-RPC data event")
    return messages[-1]


def find_session_id(value: Any) -> str | None:
    if isinstance(value, dict):
        candidate = value.get("sessionId")
        if isinstance(candidate, str) and candidate:
            return candidate
        for child in value.values():
            found = find_session_id(child)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = find_session_id(child)
            if found:
                return found
    elif isinstance(value, str):
        try:
            decoded = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            decoded = None
        if decoded is not None and decoded != value:
            found = find_session_id(decoded)
            if found:
                return found
        match = re.search(r'"?sessionId"?\s*[:=]\s*"([^"\s]+)"', value)
        if match:
            return match.group(1)
    return None


class McpClient:
    def __init__(self, api_key: str, keep_alive: bool = True) -> None:
        query = {"browserbaseApiKey": api_key}
        if keep_alive:
            query["keepAlive"] = "true"
        self.url = BASE_URL + "?" + urllib.parse.urlencode(query)
        self.api_key = api_key
        self.mcp_session_id: str | None = None
        self.next_id = 1

    def safe(self, text: str) -> str:
        return text.replace(self.api_key, "<redacted>")

    def request(self, method: str, params: dict[str, Any] | None = None, *, notification: bool = False) -> Any:
        payload: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        if not notification:
            payload["id"] = self.next_id
            self.next_id += 1

        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "User-Agent": "chatgpt-browser-bridge/browserbase-smoke",
        }
        if self.mcp_session_id:
            headers["Mcp-Session-Id"] = self.mcp_session_id

        req = urllib.request.Request(
            self.url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                returned_session = resp.headers.get("Mcp-Session-Id")
                if returned_session:
                    self.mcp_session_id = returned_session
                body = resp.read().decode("utf-8", errors="replace")
                parsed = parse_response(body, resp.headers.get("Content-Type", ""))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            fail(f"Browserbase MCP HTTP {exc.code}: {self.safe(body)[:1500]}")
        except urllib.error.URLError as exc:
            fail(f"Browserbase MCP connection failed: {exc.reason}")
        except (json.JSONDecodeError, ValueError) as exc:
            fail(f"Could not parse Browserbase MCP response: {exc}")

        if isinstance(parsed, dict) and "error" in parsed:
            fail("Browserbase MCP JSON-RPC error: " + self.safe(json.dumps(parsed["error"], sort_keys=True)))
        return parsed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--start",
        action="store_true",
        help="Create one billable Browserbase session and immediately close it",
    )
    args = parser.parse_args()

    api_key = os.environ.get("BROWSERBASE_API_KEY", "").strip()
    if not api_key:
        fail("BROWSERBASE_API_KEY is not set")

    client = McpClient(api_key)

    print("endpoint=https://mcp.browserbase.com/mcp?browserbaseApiKey=<redacted>&keepAlive=true")
    print("initialize=starting")
    initialized = client.request(
        "initialize",
        {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "chatgpt-browser-bridge", "version": "1"},
        },
    )
    if not isinstance(initialized, dict) or "result" not in initialized:
        fail("initialize returned no JSON-RPC result")
    print("initialize=ok")

    client.request("notifications/initialized", notification=True)

    tools_response = client.request("tools/list", {})
    try:
        tools = tools_response["result"]["tools"]
        tool_names = {tool["name"] for tool in tools}
    except (KeyError, TypeError):
        fail("tools/list returned an unexpected shape")

    print("tools=" + ",".join(sorted(tool_names)))
    missing = EXPECTED_TOOLS - tool_names
    if missing:
        fail("expected Browserbase tools missing: " + ",".join(sorted(missing)), 2)
    print("tools_expected=ok")

    if not args.start:
        print("browser_session=not_created")
        print("BROWSERBASE_MCP_SMOKE_OK=1")
        return 0

    browser_session_id: str | None = None
    try:
        start_response = client.request("tools/call", {"name": "start", "arguments": {}})
        browser_session_id = find_session_id(start_response)
        if not browser_session_id:
            fail("start succeeded but no Browserbase sessionId could be found in the response")
        print(f"browser_session_started={browser_session_id}")
        print("browser_session_available=ok")
    finally:
        if browser_session_id:
            try:
                client.request(
                    "tools/call",
                    {"name": "end", "arguments": {"sessionId": browser_session_id}},
                )
                print(f"browser_session_ended={browser_session_id}")
            except SystemExit:
                print(
                    "WARNING: Browserbase session was created but automatic end failed; close it in the Browserbase dashboard.",
                    file=sys.stderr,
                )
                raise

    print("BROWSERBASE_MCP_SMOKE_OK=1")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
