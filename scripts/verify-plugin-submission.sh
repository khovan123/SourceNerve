#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${SOURCENERVE_PLUGIN_BASE_URL:-https://sourcenerve.fogewise.io.vn}"
RESOURCE="${SOURCENERVE_OAUTH_RESOURCE:-https://sourcenerve.fogewise.io.vn/mcp}"
MCP_URL="${SOURCENERVE_PLUGIN_MCP_URL:-}"
MANIFEST="plugins/sourcenerve/.codex-plugin/plugin.json"
LEGACY_MCP_CONFIG="plugins/sourcenerve/.mcp.json"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

for command in curl jq python3; do
  command -v "$command" >/dev/null 2>&1 || fail "$command is required"
done

[[ -n "$MCP_URL" ]] || fail "SOURCENERVE_PLUGIN_MCP_URL must be set to the installation-specific Desktop MCP URL"
[[ -f "$MANIFEST" ]] || fail "$MANIFEST is missing"
[[ ! -e "$LEGACY_MCP_CONFIG" ]] || fail "$LEGACY_MCP_CONFIG must not bind the plugin package to the central control-plane /mcp URL"
[[ -f plugins/sourcenerve/assets/icon.png ]] || fail "plugin icon is missing"
[[ -f plugins/sourcenerve/assets/logo.png ]] || fail "plugin logo is missing"
[[ -f plugins/sourcenerve/skills/chatgpt-review-loop/SKILL.md ]] || fail "ChatGPT review-loop skill is missing"
[[ -f plugins/sourcenerve/skills/karpathy-guidelines/SKILL.md ]] || fail "Karpathy default coding skill is missing"
[[ -f plugins/sourcenerve/skills/repository-change-workflow/SKILL.md ]] || fail "repository workflow skill is missing"
[[ -f docs/plugin-tool-review.md ]] || fail "tool review matrix is missing"
[[ -f docs/plugin-submission.md ]] || fail "submission dossier is missing"

jq -e . "$MANIFEST" >/dev/null
jq -e '
  .name == "sourcenerve"
  and (.mcpServers == null)
  and (.skills | type == "string")
' "$MANIFEST" >/dev/null || fail "SourceNerve plugin package must remain skills-only; MCP transport is installation-scoped"

readarray -t parsed_urls < <(python3 - "$MCP_URL" "$BASE_URL" "$RESOURCE" <<'PY'
import sys
from urllib.parse import urlsplit

mcp = urlsplit(sys.argv[1])
control = urlsplit(sys.argv[2])
resource = urlsplit(sys.argv[3])

def credential_free_https(value, label):
    if value.scheme != "https" or not value.hostname or value.username or value.password or value.query or value.fragment:
        raise SystemExit(f"{label} must be credential-free HTTPS without query or fragment")

credential_free_https(mcp, "MCP URL")
credential_free_https(control, "control-plane URL")
credential_free_https(resource, "OAuth resource")

if mcp.path.rstrip("/") != "/mcp":
    raise SystemExit("MCP URL path must be /mcp")
if resource.path.rstrip("/") != "/mcp":
    raise SystemExit("OAuth resource path must be /mcp")

mcp_origin = f"{mcp.scheme}://{mcp.netloc}"
control_origin = f"{control.scheme}://{control.netloc}"
resource_origin = f"{resource.scheme}://{resource.netloc}"
if mcp_origin == control_origin:
    raise SystemExit("MCP URL must be installation-specific; the central control-plane origin does not serve /mcp")
if resource_origin != control_origin:
    raise SystemExit("OAuth resource must stay on the canonical SourceNerve control-plane origin")

resource_path = resource.path.strip("/")
metadata_url = f"{resource_origin}/.well-known/oauth-protected-resource/{resource_path}"
print(mcp_origin)
print(metadata_url)
PY
)
[[ "${#parsed_urls[@]}" -eq 2 ]] || fail "unable to parse SourceNerve MCP/OAuth URLs"
MCP_ORIGIN="${parsed_urls[0]}"
METADATA_URL="${parsed_urls[1]}"

printf 'Checking SourceNerve control-plane publication surface at %s\n' "$BASE_URL"
for path in / /privacy /terms /support /healthz; do
  code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "${BASE_URL%/}${path}")"
  [[ "$code" == 200 ]] || fail "${path} returned HTTP ${code}, expected 200"
  printf '  %s: ok\n' "$path"
done

printf 'Checking canonical OAuth metadata at %s\n' "$METADATA_URL"
metadata="$(curl --silent --show-error --fail "$METADATA_URL")"
jq -e --arg resource "$RESOURCE" '
  .resource == $resource
  and (.authorization_servers | type == "array" and length > 0)
  and (.scopes_supported | index("sourcenerve:read") != null)
  and (.scopes_supported | index("sourcenerve:write") != null)
' <<<"$metadata" >/dev/null || fail "protected-resource metadata does not advertise the canonical SourceNerve OAuth resource"
printf '  OAuth protected-resource metadata: ok\n'

printf 'Checking installation-scoped SourceNerve MCP at %s\n' "$MCP_URL"
headers="$(mktemp)"
body="$(mktemp)"
trap 'rm -f "$headers" "$body"' EXIT
code="$(curl --silent --show-error --dump-header "$headers" --output "$body" --write-out '%{http_code}' "$MCP_URL")"
[[ "$code" == 401 ]] || fail "unauthenticated installation MCP returned HTTP ${code}, expected 401"
grep -qi '^www-authenticate: Bearer ' "$headers" || fail "MCP 401 is missing Bearer challenge"
grep -Fq "resource_metadata=\"${METADATA_URL}\"" "$headers" \
  || fail "MCP Bearer challenge does not point to the canonical protected-resource metadata URL"
printf '  unauthenticated MCP OAuth challenge: ok\n'

issuer="$(jq -r '.authorization_servers[0]' <<<"$metadata")"
[[ "$issuer" == https://* ]] || fail "authorization server is not HTTPS"
discovery="$(curl --silent --show-error --fail "${issuer%/}/.well-known/openid-configuration")"
jq -e --arg issuer "$issuer" '
  ((.issuer | rtrimstr("/")) == ($issuer | rtrimstr("/")))
  and (.authorization_endpoint | type == "string" and startswith("https://"))
  and (.token_endpoint | type == "string" and startswith("https://"))
  and (.jwks_uri | type == "string" and startswith("https://"))
  and (.registration_endpoint | type == "string" and startswith("https://"))
  and (.code_challenge_methods_supported | type == "array" and index("S256") != null)
  and (.token_endpoint_auth_methods_supported | type == "array" and length > 0)
  and (.scopes_supported | index("offline_access") != null)
' <<<"$discovery" >/dev/null || fail "OIDC discovery is missing ChatGPT MCP requirements (DCR, PKCE S256, token auth methods, or offline_access)"
printf '  OIDC discovery + DCR + PKCE S256 + offline_access: ok\n'

if [[ -n "${SOURCENERVE_OPENAI_APPS_CHALLENGE:-}" ]]; then
  challenge="$(curl --silent --show-error --fail "${MCP_ORIGIN}/.well-known/openai-apps-challenge")"
  [[ "$challenge" == "$SOURCENERVE_OPENAI_APPS_CHALLENGE" ]] \
    || fail "installation MCP challenge endpoint does not return the exact configured token"
  printf '  OpenAI domain challenge: ok\n'
else
  printf '  OpenAI domain challenge: skipped (SOURCENERVE_OPENAI_APPS_CHALLENGE not set)\n'
fi

printf '\nSourceNerve installation MCP preflight passed.\n'
printf 'MCP transport: %s\n' "$MCP_URL"
printf 'OAuth resource: %s\n' "$RESOURCE"
printf 'OAuth metadata: %s\n' "$METADATA_URL"
