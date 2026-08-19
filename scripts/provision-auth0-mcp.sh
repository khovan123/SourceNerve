#!/usr/bin/env bash
set -euo pipefail

# Idempotently provision the Auth0 tenant settings, SourceNerve API, and the
# default third-party user grant required by dynamically registered MCP clients.
#
# Required environment variables:
#   AUTH0_DOMAIN       tenant domain only, e.g. example.us.auth0.com
#   AUTH0_MGMT_TOKEN   Management API token with:
#                     read/update tenant settings,
#                     read/create/update resource servers,
#                     read/create/update client grants
#
# Optional:
#   SOURCENERVE_MCP_RESOURCE             defaults to the production SourceNerve MCP URL
#   SOURCENERVE_OAUTH_TOKEN_LIFETIME     defaults to 300 seconds

: "${AUTH0_DOMAIN:?set AUTH0_DOMAIN to the Auth0 tenant domain, without https://}"
: "${AUTH0_MGMT_TOKEN:?set AUTH0_MGMT_TOKEN to an Auth0 Management API token}"

RESOURCE="${SOURCENERVE_MCP_RESOURCE:-https://sourcenerve.fogewise.io.vn/mcp}"
TOKEN_LIFETIME="${SOURCENERVE_OAUTH_TOKEN_LIFETIME:-300}"
READ_SCOPE="sourcenerve:read"
WRITE_SCOPE="sourcenerve:write"
API_BASE="https://${AUTH0_DOMAIN}/api/v2"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

for command in curl jq python3; do
  command -v "$command" >/dev/null 2>&1 || fail "$command is required"
done

case "$AUTH0_DOMAIN" in
  http://*|https://*|*/*) fail "AUTH0_DOMAIN must be a hostname only" ;;
esac
[[ "$AUTH0_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || fail "AUTH0_DOMAIN contains unsupported characters"
[[ "$RESOURCE" == https://* ]] || fail "SOURCENERVE_MCP_RESOURCE must be HTTPS"
[[ "$TOKEN_LIFETIME" =~ ^[0-9]+$ ]] || fail "SOURCENERVE_OAUTH_TOKEN_LIFETIME must be an integer"
(( TOKEN_LIFETIME >= 60 && TOKEN_LIFETIME <= 3600 )) || fail "token lifetime must be between 60 and 3600 seconds"

api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local args=(
    --silent --show-error --fail-with-body
    --request "$method"
    --url "${API_BASE}${path}"
    --header "Authorization: Bearer ${AUTH0_MGMT_TOKEN}"
    --header 'Accept: application/json'
  )
  if [[ -n "$body" ]]; then
    args+=(--header 'Content-Type: application/json' --data "$body")
  fi
  curl "${args[@]}"
}

printf 'Configuring Auth0 tenant %s for MCP resource %s\n' "$AUTH0_DOMAIN" "$RESOURCE"

# RFC 8707/MCP resource compatibility + strict DCR. DCR itself remains an
# explicit tenant flag because ChatGPT/other MCP clients may register at runtime.
tenant_patch="$(jq -cn '{
  flags: { enable_dynamic_client_registration: true },
  resource_parameter_profile: "compatibility",
  dynamic_client_registration_security_mode: "strict"
}')"
api PATCH '/tenants/settings' "$tenant_patch" >/dev/null
printf '  tenant: resource compatibility + strict DCR enabled\n'

encoded_resource="$(python3 - "$RESOURCE" <<'PY'
import sys, urllib.parse
print(urllib.parse.quote(sys.argv[1], safe=''))
PY
)"

resource_servers="$(api GET "/resource-servers?identifiers=${encoded_resource}&per_page=10")"
resource_id="$(jq -r --arg identifier "$RESOURCE" '
  if type == "array" then . else (.resource_servers // []) end
  | map(select(.identifier == $identifier))
  | .[0].id // empty
' <<<"$resource_servers")"

resource_body="$(jq -cn \
  --arg identifier "$RESOURCE" \
  --arg read_scope "$READ_SCOPE" \
  --arg write_scope "$WRITE_SCOPE" \
  --argjson lifetime "$TOKEN_LIFETIME" '
  {
    identifier: $identifier,
    name: "SourceNerve MCP",
    signing_alg: "RS256",
    allow_offline_access: true,
    token_lifetime: $lifetime,
    token_dialect: "access_token",
    scopes: [
      { value: $read_scope, description: "Read authorized SourceNerve workspaces" },
      { value: $write_scope, description: "Mutate authorized SourceNerve workspaces through guarded tools" }
    ],
    subject_type_authorization: {
      user: { policy: "allow_all" },
      client: { policy: "deny_all" }
    }
  }
')"

if [[ -z "$resource_id" ]]; then
  created="$(api POST '/resource-servers' "$resource_body")"
  resource_id="$(jq -r '.id' <<<"$created")"
  [[ -n "$resource_id" && "$resource_id" != null ]] || fail "Auth0 did not return a resource server id"
  printf '  API: created %s\n' "$resource_id"
else
  # identifier is immutable, so omit it from the PATCH body.
  patch_body="$(jq 'del(.identifier)' <<<"$resource_body")"
  api PATCH "/resource-servers/${resource_id}" "$patch_body" >/dev/null
  printf '  API: updated %s\n' "$resource_id"
fi

# DCR-created third-party clients need an explicit default client grant. Allow
# both SourceNerve scopes at the OAuth client level; SourceNerve still enforces
# exact per-user workspace read-only/read-write grants before any tool runs.
grants="$(api GET "/client-grants?audience=${encoded_resource}&subject_type=user&per_page=100")"
grant_id="$(jq -r '
  if type == "array" then . else (.client_grants // []) end
  | map(select(.default_for == "third_party_clients" and .subject_type == "user"))
  | .[0].id // empty
' <<<"$grants")"

grant_body="$(jq -cn \
  --arg audience "$RESOURCE" \
  --arg read_scope "$READ_SCOPE" \
  --arg write_scope "$WRITE_SCOPE" '
  {
    default_for: "third_party_clients",
    audience: $audience,
    scope: [$read_scope, $write_scope],
    subject_type: "user"
  }
')"

if [[ -z "$grant_id" ]]; then
  created_grant="$(api POST '/client-grants' "$grant_body")"
  grant_id="$(jq -r '.id' <<<"$created_grant")"
  [[ -n "$grant_id" && "$grant_id" != null ]] || fail "Auth0 did not return a client grant id"
  printf '  third-party user grant: created %s\n' "$grant_id"
else
  grant_patch="$(jq '{scope}' <<<"$grant_body")"
  api PATCH "/client-grants/${grant_id}" "$grant_patch" >/dev/null
  printf '  third-party user grant: updated %s\n' "$grant_id"
fi

printf '\nAuth0 provisioning complete.\n'
printf 'Issuer:   https://%s/\n' "$AUTH0_DOMAIN"
printf 'Resource: %s\n' "$RESOURCE"
printf 'Scopes:   %s %s offline_access\n' "$READ_SCOPE" "$WRITE_SCOPE"
printf '\nNext: add exact Auth0 user sub values to [[oauth.grant]] in the server SourceNerve config.\n'
