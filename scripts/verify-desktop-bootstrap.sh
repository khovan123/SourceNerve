#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="$ROOT_DIR/desktop/bootstrap/product-profile.template.json"
SCHEMA="$ROOT_DIR/desktop/bootstrap/product-profile.schema.json"

python3 - "$PROFILE" "$SCHEMA" <<'PY'
import json
import pathlib
import re
import sys
from urllib.parse import urlparse

profile_path = pathlib.Path(sys.argv[1])
schema_path = pathlib.Path(sys.argv[2])
for path in (profile_path, schema_path):
    if not path.is_file():
        raise SystemExit(f"missing desktop bootstrap artifact: {path}")
with profile_path.open("r", encoding="utf-8") as handle:
    profile = json.load(handle)
with schema_path.open("r", encoding="utf-8") as handle:
    schema = json.load(handle)
if profile.get("schemaVersion") != 1:
    raise SystemExit("desktop bootstrap schemaVersion must be 1")
if schema.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
    raise SystemExit("desktop bootstrap schema must use JSON Schema 2020-12")

product = profile["product"]
daemon = profile["daemon"]
desktop_behavior = profile["desktopBehavior"]
auth0 = profile["auth0"]
git_providers = profile["gitProviders"]
public_mcp = profile["publicMcp"]
broker = profile["bootstrapBroker"]
cloudflare = profile["cloudflare"]
installation = profile["installation"]
workspace = profile["workspace"]

if product["name"] != "SourceNerve":
    raise SystemExit("unexpected desktop product name")
for key in ("websiteUrl", "supportUrl", "privacyUrl", "termsUrl"):
    if not product[key].startswith("https://"):
        raise SystemExit(f"{key} must use https")
if daemon.get("managed") is not True or daemon.get("bind") != "127.0.0.1:7331":
    raise SystemExit("desktop daemon must stay managed and loopback-bound")
if daemon.get("mcpPath") != "/mcp" or daemon.get("healthPath") != "/healthz":
    raise SystemExit("desktop daemon paths drifted from the SourceNerve contract")
for key in ("allowBackgroundMode", "allowLaunchAtLogin", "allowNotifications"):
    if not isinstance(desktop_behavior.get(key), bool):
        raise SystemExit(f"desktop behavior policy requires boolean {key}")
if auth0.get("flow") != "authorization_code_pkce":
    raise SystemExit("desktop Auth0 flow must be authorization_code_pkce")
if not auth0.get("issuer", "").startswith("https://") or not auth0["issuer"].endswith("/"):
    raise SystemExit("Auth0 issuer must be canonical https issuer ending in slash")
if auth0.get("audience") != public_mcp.get("resource"):
    raise SystemExit("Auth0 audience must equal the canonical public MCP resource")
required_scopes = {"openid", "profile", "email", "offline_access", "sourcenerve:read", "sourcenerve:write"}
if not required_scopes.issubset(set(auth0.get("scopes", []))):
    raise SystemExit("desktop Auth0 scopes are incomplete")
if not auth0.get("callbackUri", "").startswith("sourcenerve://"):
    raise SystemExit("desktop Auth0 callback must use the reviewed SourceNerve scheme")

expected_provider_origins = {
    "github": ("https://github.com", "https://api.github.com"),
    "gitlab": ("https://gitlab.com", "https://gitlab.com"),
}
for name, (auth_origin, api_origin) in expected_provider_origins.items():
    provider = git_providers.get(name)
    if not isinstance(provider, dict):
        raise SystemExit(f"missing Desktop {name} provider profile")
    if provider.get("flow") != "device_authorization":
        raise SystemExit(f"Desktop {name} provider must use device_authorization")
    if not provider.get("scopes") or len(set(provider["scopes"])) != len(provider["scopes"]):
        raise SystemExit(f"Desktop {name} scopes must be non-empty and unique")
    for key in ("deviceCodeUrl", "tokenUrl", "apiBaseUrl", "verificationOrigin"):
        value = provider.get(key, "")
        parsed = urlparse(value)
        if parsed.scheme != "https" or parsed.username or parsed.password or parsed.fragment:
            raise SystemExit(f"Desktop {name} {key} must be credential-free HTTPS")
    if provider["verificationOrigin"].rstrip("/") != auth_origin:
        raise SystemExit(f"Desktop {name} verification origin changed unexpectedly")
    if f"{urlparse(provider['deviceCodeUrl']).scheme}://{urlparse(provider['deviceCodeUrl']).netloc}" != auth_origin:
        raise SystemExit(f"Desktop {name} device endpoint escaped the provider origin")
    if f"{urlparse(provider['tokenUrl']).scheme}://{urlparse(provider['tokenUrl']).netloc}" != auth_origin:
        raise SystemExit(f"Desktop {name} token endpoint escaped the provider origin")
    if f"{urlparse(provider['apiBaseUrl']).scheme}://{urlparse(provider['apiBaseUrl']).netloc}" != api_origin:
        raise SystemExit(f"Desktop {name} API origin changed unexpectedly")

if public_mcp.get("resource") != "https://sourcenerve.fogewise.io.vn/mcp":
    raise SystemExit("canonical public MCP resource changed unexpectedly")
if public_mcp.get("protectedResourceMetadata") != "https://sourcenerve.fogewise.io.vn/.well-known/oauth-protected-resource/mcp":
    raise SystemExit("protected-resource metadata URL changed unexpectedly")
if installation.get("localBearerEntropyBits", 0) < 256:
    raise SystemExit("local bearer entropy must be at least 256 bits")
if installation.get("generateInstallationId") is not True or installation.get("secureStoreRequired") is not True:
    raise SystemExit("desktop installation identity/secure-store policy changed unexpectedly")
if cloudflare.get("desktopReceivesAccountApiToken") is not False:
    raise SystemExit("desktop must never receive the Cloudflare account API token")
for key in ("userSelectsRepository", "userSelectsLocalRoot", "userSelectsAccessMode", "deriveProviderMetadata"):
    if workspace.get(key) is not True:
        raise SystemExit(f"workspace UX contract requires {key}=true")

allowed_placeholders = {
    "__SOURCENERVE_AUTH0_NATIVE_CLIENT_ID__",
    "__SOURCENERVE_BOOTSTRAP_BROKER_URL__",
    "__SOURCENERVE_GITHUB_OAUTH_CLIENT_ID__",
    "__SOURCENERVE_GITLAB_OAUTH_CLIENT_ID__",
}
placeholder_re = re.compile(r"^__[A-Z0-9_]+__$")
for value in (
    auth0.get("nativeClientId"),
    broker.get("baseUrl"),
    git_providers["github"].get("clientId"),
    git_providers["gitlab"].get("clientId"),
):
    if placeholder_re.match(value or "") and value not in allowed_placeholders:
        raise SystemExit(f"unexpected desktop bootstrap placeholder: {value}")

for endpoint_path in (broker.get("enrollPath"), broker.get("rotateTunnelPath"), broker.get("revokePath"), broker.get("statusPath")):
    if not isinstance(endpoint_path, str) or not endpoint_path.startswith("/"):
        raise SystemExit("bootstrap broker endpoint paths must be absolute paths")

forbidden_keys = {
    "access_token", "accessToken", "refresh_token", "refreshToken", "client_secret", "clientSecret",
    "management_api_token", "managementApiToken", "cloudflare_api_token", "cloudflareApiToken",
    "cloudflare_tunnel_token", "cloudflareTunnelToken", "bearer_token", "bearerToken",
    "github_token", "githubToken", "gitlab_token", "gitlabToken", "password",
}
suspicious_prefixes = ("ghp_", "github_pat_", "glpat-")
def walk(value, path="$"):
    if isinstance(value, dict):
        for key, child in value.items():
            if key in forbidden_keys:
                raise SystemExit(f"forbidden secret field in desktop profile: {path}.{key}")
            walk(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            walk(child, f"{path}[{index}]")
    elif isinstance(value, str) and value.startswith(suspicious_prefixes):
        raise SystemExit(f"credential-like literal found in desktop profile: {path}")
walk(profile)
print("desktop bootstrap profile verification: ok")
PY
