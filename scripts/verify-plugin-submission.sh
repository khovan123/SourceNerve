#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${SOURCENERVE_PLUGIN_BASE_URL:-https://sourcenerve.fogewise.io.vn}"
MCP_URL="${SOURCENERVE_PLUGIN_MCP_URL:-}"
MANIFEST="plugins/sourcenerve/.codex-plugin/plugin.json"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

for command in curl jq python3; do
  command -v "$command" >/dev/null 2>&1 || fail "$command is required"
done

[[ -n "$MCP_URL" ]] || fail "SOURCENERVE_PLUGIN_MCP_URL must be set to the installation-specific Desktop MCP URL"
[[ -f "$MANIFEST" ]] || fail "$MANIFEST is missing"
jq -e '.name == "sourcenerve" and (.mcpServers == null) and (.skills | type == "string")' "$MANIFEST" >/dev/null   || fail "SourceNerve plugin package must remain skills-only"

MCP_ORIGIN="$(python3 - "$MCP_URL" "$BASE_URL" <<'PY'
import sys
from urllib.parse import urlsplit
mcp=urlsplit(sys.argv[1]); control=urlsplit(sys.argv[2])
for value,label in ((mcp,"MCP URL"),(control,"control-plane URL")):
    if value.scheme!="https" or not value.hostname or value.username or value.password or value.query or value.fragment:
        raise SystemExit(f"{label} must be credential-free HTTPS")
if mcp.path.rstrip("/")!="/mcp":
    raise SystemExit("MCP URL path must be /mcp")
mcp_origin=f"{mcp.scheme}://{mcp.netloc}"
control_origin=f"{control.scheme}://{control.netloc}"
if mcp_origin==control_origin:
    raise SystemExit("MCP URL must be installation-specific")
print(mcp_origin)
PY
)"

for path in / /privacy /terms /support /healthz; do
  code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "${BASE_URL%/}${path}")"
  [[ "$code" == 200 ]] || fail "${path} returned HTTP ${code}, expected 200"
done

payload='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"SourceNerve preflight","version":"1"}}}'
body="$(curl --silent --show-error --fail   --header 'content-type: application/json'   --header 'accept: application/json, text/event-stream'   --data "$payload" "$MCP_URL")"
grep -q '"result"' <<<"$body" || fail "anonymous MCP initialize did not return a JSON-RPC result"

if [[ -n "${SOURCENERVE_OPENAI_APPS_CHALLENGE:-}" ]]; then
  challenge="$(curl --silent --show-error --fail "${MCP_ORIGIN}/.well-known/openai-apps-challenge")"
  [[ "$challenge" == "$SOURCENERVE_OPENAI_APPS_CHALLENGE" ]] || fail "OpenAI domain challenge mismatch"
fi

printf 'SourceNerve No Auth plugin preflight passed.\n'
printf 'MCP transport: %s\n' "$MCP_URL"
printf 'Authentication: No Auth\n'
