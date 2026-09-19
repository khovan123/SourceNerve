#!/usr/bin/env bash
set -euo pipefail

# Idempotently provision the Auth0 tenant settings, SourceNerve API, ChatGPT
# CIMD client, domain-level login connections, and the default third-party user
# grant required by MCP clients.
#
# Required environment variables:
#   AUTH0_DOMAIN       tenant domain only, e.g. example.us.auth0.com
#   AUTH0_MGMT_TOKEN   Management API token with:
#                     update:tenant_settings,
#                     read/create/update:resource_servers,
#                     read/create/update:client_grants,
#                     read/update:connections,
#                     create/update:clients
#
# Optional:
#   SOURCENERVE_MCP_RESOURCE                  defaults to the canonical SourceNerve OAuth resource
#   SOURCENERVE_OAUTH_TOKEN_LIFETIME          defaults to 300 seconds
#   SOURCENERVE_CHATGPT_CIMD_CLIENT_ID        defaults to https://chatgpt.com/oauth/client.json
#   SOURCENERVE_AUTH0_DOMAIN_CONNECTION_IDS   comma-separated exact Auth0 connection ids to promote

: "${AUTH0_DOMAIN:?set AUTH0_DOMAIN to the Auth0 tenant domain, without https://}"
: "${AUTH0_MGMT_TOKEN:?set AUTH0_MGMT_TOKEN to an Auth0 Management API token}"

RESOURCE="${SOURCENERVE_MCP_RESOURCE:-https://sourcenerve.fogewise.io.vn/mcp}"
TOKEN_LIFETIME="${SOURCENERVE_OAUTH_TOKEN_LIFETIME:-300}"
CHATGPT_CIMD_CLIENT_ID="${SOURCENERVE_CHATGPT_CIMD_CLIENT_ID:-https://chatgpt.com/oauth/client.json}"
DOMAIN_CONNECTION_IDS="${SOURCENERVE_AUTH0_DOMAIN_CONNECTION_IDS:-}"
READ_SCOPE="sourcenerve:read"
WRITE_SCOPE="sourcenerve:write"
API_BASE="https://${AUTH0_DOMAIN}/api/v2"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

for command in curl jq python3 xargs; do
  command -v "$command" >/dev/null 2>&1 || fail "$command is required"
done

case "$AUTH0_DOMAIN" in
  http://*|https://*|*/*) fail "AUTH0_DOMAIN must be a hostname only" ;;
esac
[[ "$AUTH0_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || fail "AUTH0_DOMAIN contains unsupported characters"
[[ "$RESOURCE" == https://* ]] || fail "SOURCENERVE_MCP_RESOURCE must be HTTPS"
[[ "$CHATGPT_CIMD_CLIENT_ID" == https://* ]] || fail "SOURCENERVE_CHATGPT_CIMD_CLIENT_ID must be HTTPS"
[[ "$TOKEN_LIFETIME" =~ ^[0-9]+$ ]] || fail "SOURCENERVE_OAUTH_TOKEN_LIFETIME must be an integer"
(( TOKEN_LIFETIME >= 60 && TOKEN_LIFETIME <= 3600 )) || fail "token lifetime must be between 60 and 3600 seconds"

api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local response
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

  if ! response="$(curl "${args[@]}")"; then
    if [[ -n "$response" ]]; then
      printf 'Auth0 API error for %s %s:\n%s\n' "$method" "$path" "$response" >&2
    fi
    return 1
  fi
  printf '%s' "$response"
}

printf 'Inspecting Auth0 login connections for third-party MCP clients\n'
connections="$(api GET '/connections?per_page=100')"
connection_array="$(jq -c 'if type == "array" then . else (.connections // []) end' <<<"$connections")"

if [[ -n "$DOMAIN_CONNECTION_IDS" ]]; then
  IFS=',' read -r -a requested_connections <<<"$DOMAIN_CONNECTION_IDS"
  for raw_id in "${requested_connections[@]}"; do
    connection_id="$(xargs <<<"$raw_id")"
    [[ "$connection_id" =~ ^con_[A-Za-z0-9]+$ ]] || fail "invalid Auth0 connection id: $connection_id"
    jq -e --arg id "$connection_id" 'any(.[]; .id == $id)' <<<"$connection_array" >/dev/null       || fail "Auth0 connection id $connection_id was not found"
  done
else
  domain_count="$(jq '[.[] | select(.is_domain_connection == true)] | length' <<<"$connection_array")"
  if [[ "$domain_count" -lt 1 ]]; then
    jq -r '.[] | "  \(.id)  \(.name)  strategy=\(.strategy)  domain=\(.is_domain_connection // false)"' <<<"$connection_array" >&2
    fail "ChatGPT third-party OAuth needs at least one domain-level Auth0 login connection; set SOURCENERVE_AUTH0_DOMAIN_CONNECTION_IDS to the exact connection id(s) to promote"
  fi
fi

printf 'Configuring Auth0 tenant %s for MCP resource %s\n' "$AUTH0_DOMAIN" "$RESOURCE"
tenant_patch="$(jq -cn '{
  resource_parameter_profile: "compatibility",
  client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true,
  flags: { enable_dynamic_client_registration: false },
  dynamic_client_registration_security_mode: "strict"
}')"
api PATCH '/tenants/settings' "$tenant_patch" >/dev/null
printf '  tenant: resource compatibility + CIMD + RFC 9207 issuer identification enabled; DCR disabled\n'

if [[ -n "$DOMAIN_CONNECTION_IDS" ]]; then
  for raw_id in "${requested_connections[@]}"; do
    connection_id="$(xargs <<<"$raw_id")"
    if jq -e --arg id "$connection_id" 'any(.[]; .id == $id and .is_domain_connection == true)' <<<"$connection_array" >/dev/null; then
      printf '  connection: %s already domain-level\n' "$connection_id"
      continue
    fi
    api PATCH "/connections/${connection_id}" '{"is_domain_connection":true}' >/dev/null
    printf '  connection: promoted %s to domain level\n' "$connection_id"
  done
fi

connections="$(api GET '/connections?per_page=100')"
connection_array="$(jq -c 'if type == "array" then . else (.connections // []) end' <<<"$connections")"
domain_count="$(jq '[.[] | select(.is_domain_connection == true)] | length' <<<"$connection_array")"
(( domain_count >= 1 )) || fail "no domain-level Auth0 login connection is available after provisioning"
printf '  connections: %s domain-level login connection(s) available to third-party clients\n' "$domain_count"

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

resource_body="$(jq -cn   --arg identifier "$RESOURCE"   --arg read_scope "$READ_SCOPE"   --arg write_scope "$WRITE_SCOPE"   --argjson lifetime "$TOKEN_LIFETIME" '
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
    ]
  }
')"

if [[ -z "$resource_id" ]]; then
  created="$(api POST '/resource-servers' "$resource_body")"
  resource_id="$(jq -r '.id' <<<"$created")"
  [[ -n "$resource_id" && "$resource_id" != null ]] || fail "Auth0 did not return a resource server id"
  printf '  API: created %s\n' "$resource_id"
else
  patch_body="$(jq 'del(.identifier)' <<<"$resource_body")"
  api PATCH "/resource-servers/${resource_id}" "$patch_body" >/dev/null
  printf '  API: updated %s\n' "$resource_id"
fi

grants="$(api GET "/client-grants?audience=${encoded_resource}&subject_type=user&per_page=100")"
grant_id="$(jq -r '
  if type == "array" then . else (.client_grants // []) end
  | map(select(.default_for == "third_party_clients" and .subject_type == "user"))
  | .[0].id // empty
' <<<"$grants")"

grant_body="$(jq -cn   --arg audience "$RESOURCE"   --arg read_scope "$READ_SCOPE"   --arg write_scope "$WRITE_SCOPE" '
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

cimd_body="$(jq -cn --arg external_client_id "$CHATGPT_CIMD_CLIENT_ID" '{external_client_id: $external_client_id}')"
cimd="$(api POST '/clients/cimd/register' "$cimd_body")"
jq -e --arg external "$CHATGPT_CIMD_CLIENT_ID" '
  (.client_id | type == "string" and length > 0)
  and .validation.valid == true
  and .mapped_fields.external_client_id == $external
' <<<"$cimd" >/dev/null || {
  jq '.validation // .' <<<"$cimd" >&2
  fail "Auth0 did not validate/register the ChatGPT CIMD client"
}
printf '  ChatGPT CIMD: registered/updated idempotently %s\n' "$CHATGPT_CIMD_CLIENT_ID"

printf '\nAuth0 provisioning complete.\n'
printf 'Issuer:        https://%s/\n' "$AUTH0_DOMAIN"
printf 'Resource:      %s\n' "$RESOURCE"
printf 'ChatGPT CIMD:  %s\n' "$CHATGPT_CIMD_CLIENT_ID"
printf 'Scopes:        %s %s offline_access\n' "$READ_SCOPE" "$WRITE_SCOPE"
printf 'Domain login connections:\n'
jq -r '.[] | select(.is_domain_connection == true) | "  \(.id)  \(.name)  strategy=\(.strategy)"' <<<"$connection_array"
printf '\nChatGPT connector setup must use Advanced OAuth settings -> Client setup method: CIMD. Do not use Auto or DCR.\n'
printf 'Existing DCR-created tpc_* clients are not deleted automatically; remove stale test clients separately after confirming they are unused.\n'
