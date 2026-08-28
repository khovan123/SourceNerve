#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${SOURCENERVE_PLUGIN_BASE_URL:-https://sourcenerve.fogewise.io.vn}"
MCP_URL="${BASE_URL%/}/mcp"
METADATA_URL="${BASE_URL%/}/.well-known/oauth-protected-resource/mcp"
MANIFEST="plugins/sourcenerve/.codex-plugin/plugin.json"
MCP_CONFIG="plugins/sourcenerve/.mcp.json"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

for command in curl jq; do
  command -v "$command" >/dev/null 2>&1 || fail "$command is required"
done

[[ -f "$MANIFEST" ]] || fail "$MANIFEST is missing"
[[ -f "$MCP_CONFIG" ]] || fail "$MCP_CONFIG is missing"
[[ -f plugins/sourcenerve/assets/icon.png ]] || fail "plugin icon is missing"
[[ -f plugins/sourcenerve/assets/logo.png ]] || fail "plugin logo is missing"
[[ -f plugins/sourcenerve/skills/karpathy-guidelines/SKILL.md ]] || fail "Karpathy default coding skill is missing"
[[ -f plugins/sourcenerve/skills/repository-change-workflow/SKILL.md ]] || fail "repository workflow skill is missing"
[[ -f docs/plugin-tool-review.md ]] || fail "tool review matrix is missing"
[[ -f docs/plugin-submission.md ]] || fail "submission dossier is missing"

jq -e . "$MANIFEST" >/dev/null
jq -e . "$MCP_CONFIG" >/dev/null

jq -e --arg base "${BASE_URL%/}/" '
  .name == "sourcenerve"
  and .interface.websiteURL == $base
  and .interface.privacyPolicyURL == ($base + "privacy")
  and .interface.termsOfServiceURL == ($base + "terms")
  and (.interface.composerIcon | startswith("./assets/"))
  and (.interface.logo | startswith("./assets/"))
' "$MANIFEST" >/dev/null || fail "plugin manifest publication metadata is incomplete"

jq -e --arg mcp "$MCP_URL" '
  .sourcenerve.url == $mcp
  and (.sourcenerve.bearer_token_env_var == null)
' "$MCP_CONFIG" >/dev/null || fail "public plugin MCP config must use the production OAuth URL without a shared bearer token"

printf 'Checking SourceNerve plugin publication surface at %s\n' "$BASE_URL"
for path in / /privacy /terms /support /healthz; do
  code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "${BASE_URL%/}${path}")"
  [[ "$code" == 200 ]] || fail "${path} returned HTTP ${code}, expected 200"
  printf '  %s: ok\n' "$path"
done

metadata="$(curl --silent --show-error --fail "$METADATA_URL")"
jq -e --arg resource "$MCP_URL" '
  .resource == $resource
  and (.authorization_servers | type == "array" and length > 0)
  and (.scopes_supported | index("sourcenerve:read") != null)
  and (.scopes_supported | index("sourcenerve:write") != null)
' <<<"$metadata" >/dev/null || fail "protected-resource metadata does not match the public SourceNerve MCP"
printf '  OAuth protected-resource metadata: ok\n'

headers="$(mktemp)"
body="$(mktemp)"
trap 'rm -f "$headers" "$body"' EXIT
code="$(curl --silent --show-error --dump-header "$headers" --output "$body" --write-out '%{http_code}' "$MCP_URL")"
[[ "$code" == 401 ]] || fail "unauthenticated MCP returned HTTP ${code}, expected 401"
grep -qi '^www-authenticate: Bearer ' "$headers" || fail "MCP 401 is missing Bearer challenge"
grep -Fq "resource_metadata=\"${METADATA_URL}\"" "$headers" \
  || fail "MCP Bearer challenge is missing the exact protected-resource metadata URL"
printf '  unauthenticated MCP OAuth challenge: ok\n'

issuer="$(jq -r '.authorization_servers[0]' <<<"$metadata")"
[[ "$issuer" == https://* ]] || fail "authorization server is not HTTPS"
discovery="$(curl --silent --show-error --fail "${issuer%/}/.well-known/openid-configuration")"
jq -e '
  (.authorization_endpoint | type == "string")
  and (.token_endpoint | type == "string")
  and (.jwks_uri | type == "string")
  and (.scopes_supported | index("offline_access") != null)
' <<<"$discovery" >/dev/null || fail "OIDC discovery is incomplete or does not advertise offline_access"
printf '  OIDC discovery + offline_access: ok\n'

if [[ -n "${SOURCENERVE_OPENAI_APPS_CHALLENGE:-}" ]]; then
  challenge="$(curl --silent --show-error --fail "${BASE_URL%/}/.well-known/openai-apps-challenge")"
  [[ "$challenge" == "$SOURCENERVE_OPENAI_APPS_CHALLENGE" ]] \
    || fail "OpenAI domain challenge endpoint does not return the exact configured token"
  printf '  OpenAI domain challenge: ok\n'
else
  printf '  OpenAI domain challenge: skipped (SOURCENERVE_OPENAI_APPS_CHALLENGE not set)\n'
fi

printf '\nSourceNerve plugin submission preflight passed.\n'
printf 'MCP:     %s\n' "$MCP_URL"
printf 'Privacy: %s/privacy\n' "${BASE_URL%/}"
printf 'Terms:   %s/terms\n' "${BASE_URL%/}"
printf 'Support: %s/support\n' "${BASE_URL%/}"
