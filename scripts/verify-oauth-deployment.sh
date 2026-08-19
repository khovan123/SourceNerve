#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${SOURCENERVE_PUBLIC_BASE_URL:-https://sourcenerve.fogewise.io.vn}"
AUTH0_ISSUER="${SOURCENERVE_OAUTH_ISSUER:-}"
RESOURCE="${SOURCENERVE_MCP_RESOURCE:-${BASE_URL%/}/mcp}"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

for command in curl jq grep mktemp; do
  command -v "$command" >/dev/null 2>&1 || fail "$command is required"
done

[[ "$BASE_URL" == https://* ]] || fail "SOURCENERVE_PUBLIC_BASE_URL must be HTTPS"
[[ "$RESOURCE" == https://* ]] || fail "SOURCENERVE_MCP_RESOURCE must be HTTPS"

cleanup_files=()
cleanup() {
  if ((${#cleanup_files[@]})); then
    rm -f "${cleanup_files[@]}"
  fi
}
trap cleanup EXIT

header_file="$(mktemp)"
body_file="$(mktemp)"
cleanup_files+=("$header_file" "$body_file")

printf 'Checking SourceNerve public OAuth/MCP deployment at %s\n' "$BASE_URL"

health="$(curl --silent --show-error --fail "${BASE_URL%/}/healthz")"
jq -e '.status == "ok" and .service == "sourcenerve"' >/dev/null <<<"$health" \
  || fail "healthz did not return a healthy SourceNerve identity"
printf '  healthz: ok\n'

metadata="$(curl --silent --show-error --fail "${BASE_URL%/}/.well-known/oauth-protected-resource/mcp")"
jq -e --arg resource "$RESOURCE" '
  .resource == $resource
  and (.authorization_servers | type == "array" and length >= 1)
  and (.scopes_supported | index("sourcenerve:read") != null)
  and (.scopes_supported | index("sourcenerve:write") != null)
' >/dev/null <<<"$metadata" || fail "protected-resource metadata is incomplete or has the wrong resource URI"
printf '  RFC 9728 protected-resource metadata: ok\n'

status="$(curl --silent --show-error \
  --dump-header "$header_file" \
  --output "$body_file" \
  --write-out '%{http_code}' \
  "${BASE_URL%/}/mcp")"
[[ "$status" == 401 ]] || fail "unauthenticated /mcp expected 401, got $status"
grep -qi '^www-authenticate: Bearer ' "$header_file" || fail "missing Bearer WWW-Authenticate challenge"
grep -qi 'resource_metadata=' "$header_file" || fail "Bearer challenge does not advertise resource_metadata"
printf '  unauthenticated MCP OAuth challenge: ok\n'

if [[ -n "$AUTH0_ISSUER" ]]; then
  issuer="${AUTH0_ISSUER%/}"
  discovery="$(curl --silent --show-error --fail "${issuer}/.well-known/openid-configuration")"
  jq -e --arg issuer "${issuer}/" '
    ((.issuer | rtrimstr("/")) == ($issuer | rtrimstr("/")))
    and (.jwks_uri | startswith("https://"))
    and (.authorization_endpoint | startswith("https://"))
    and (.token_endpoint | startswith("https://"))
    and (.scopes_supported | index("offline_access") != null)
  ' >/dev/null <<<"$discovery" || fail "OIDC discovery is missing required issuer/endpoints/offline_access"
  printf '  Auth0/OIDC discovery + offline_access: ok\n'
fi

printf '\nPublic SourceNerve OAuth/MCP preflight passed.\n'
printf 'Resource: %s\n' "$RESOURCE"
