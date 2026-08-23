#!/usr/bin/env python3
"""Normalize an MCP Streamable HTTP response body to one JSON-RPC object.

SourceNerve's stateful Streamable HTTP mode uses SSE framing so connected clients
can receive server-initiated notifications such as notifications/tools/list_changed.
Smoke tests historically parsed response files as raw application/json. This helper
accepts either raw JSON or SSE `data:` frames and rewrites each file in-place with
the final JSON-RPC response/error object.
"""

from __future__ import annotations

import json
from pathlib import Path
import sys
from typing import Any


def decode_response(body: str, path: Path) -> Any:
    stripped = body.strip()
    if not stripped:
        raise ValueError(f"empty MCP response body: {path}")

    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        pass

    messages: list[Any] = []
    for raw_line in stripped.splitlines():
        line = raw_line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        messages.append(json.loads(payload))

    if not messages:
        raise ValueError(f"MCP response is neither JSON nor SSE JSON data: {path}")

    terminal = [
        message
        for message in messages
        if isinstance(message, dict)
        and "id" in message
        and ("result" in message or "error" in message)
    ]
    return terminal[-1] if terminal else messages[-1]


def normalize(path: Path) -> None:
    value = decode_response(path.read_text(encoding="utf-8"), path)
    path.write_text(json.dumps(value, separators=(",", ":")) + "\n", encoding="utf-8")


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: normalize-mcp-response.py <response-file> [...]", file=sys.stderr)
        return 2
    for raw_path in argv[1:]:
        normalize(Path(raw_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
