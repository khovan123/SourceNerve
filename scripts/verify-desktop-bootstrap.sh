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
profile = json.loads(profile_path.read_text(encoding="utf-8"))
schema = json.loads(schema_path.read_text(encoding="utf-8"))
if profile.get("schemaVersion") != 1:
    raise SystemExit("desktop bootstrap schemaVersion must be 1")
if schema.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
    raise SystemExit("desktop bootstrap schema must use JSON Schema 2020-12")
if "auth0" in profile or "oauth" in profile:
    raise SystemExit("desktop product profile must not contain Auth0/OAuth configuration")

product = profile["product"]
daemon = profile["daemon"]
desktop_behavior = profile["desktopBehavior"]
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
if public_mcp.get("authentication") != "none":
    raise SystemExit("Desktop Public MCP must use No Auth")

expected_providers = {
    "github": ("gh", "github.com", "https://api.github.com"),
    "gitlab": ("glab", "gitlab.com", "https://gitlab.com"),
}
for name, (cli, hostname, api_origin) in expected_providers.items():
    provider = git_providers.get(name)
    if not isinstance(provider, dict):
        raise SystemExit(f"missing Desktop {name} provider profile")
    if provider.get("cli") != cli or provider.get("hostname") != hostname:
        raise SystemExit(f"Desktop {name} CLI/hostname changed unexpectedly")
    parsed = urlparse(provider.get("apiBaseUrl", ""))
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.fragment:
        raise SystemExit(f"Desktop {name} API must be credential-free HTTPS")
    if f"{parsed.scheme}://{parsed.netloc}" != api_origin:
        raise SystemExit(f"Desktop {name} API origin changed unexpectedly")

if installation.get("localBearerEntropyBits", 0) < 256:
    raise SystemExit("local bearer entropy must be at least 256 bits")
if installation.get("generateInstallationId") is not True or installation.get("secureStoreRequired") is not True:
    raise SystemExit("desktop installation identity/secure-store policy changed unexpectedly")
if cloudflare.get("desktopReceivesAccountApiToken") is not False:
    raise SystemExit("desktop must never receive the Cloudflare account API token")
for key in ("userSelectsRepository", "userSelectsLocalRoot", "userSelectsAccessMode", "deriveProviderMetadata"):
    if workspace.get(key) is not True:
        raise SystemExit(f"workspace UX contract requires {key}=true")

placeholder_re = re.compile(r"^__[A-Z0-9_]+__$")
if placeholder_re.match(broker.get("baseUrl") or ""):
    raise SystemExit("desktop bootstrap broker URL must be resolved in the packaged profile")
for endpoint_path in (
    broker.get("enrollPath"),
    broker.get("rotateTunnelPath"),
    broker.get("revokePath"),
    broker.get("statusPath"),
):
    if not isinstance(endpoint_path, str) or not endpoint_path.startswith("/"):
        raise SystemExit("bootstrap broker endpoint paths must be absolute paths")

text = profile_path.read_text(encoding="utf-8").lower()
for forbidden in ("auth0", "oauth", "clientconfigpath", "protectedresourcemetadata"):
    if forbidden in text:
        raise SystemExit(f"removed authentication field still present in Desktop profile: {forbidden}")

print("desktop bootstrap profile verification: ok")
PY
