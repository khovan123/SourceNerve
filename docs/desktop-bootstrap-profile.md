# Desktop bootstrap profile

The Desktop bootstrap profile is the versioned, non-secret product contract consumed by Electron Main and the release pipeline. Normal users do not configure TOML, shell exports, account-provider identifiers, or provider OAuth client IDs.

The profile contains:

- product/legal URLs and release channel;
- managed daemon bind/health/readiness/MCP paths;
- Desktop behavior policy;
- GitHub/GitLab CLI/provider metadata;
- Public MCP mode: `authentication = "none"`, bootstrap-broker routing, installation-scoped hostname;
- bootstrap broker endpoints;
- Cloudflare installation-routing policy;
- installation/local-bearer policy;
- workspace-selection policy.

The profile never contains repository credentials, Cloudflare account credentials, local bearer values, workspace roots, or user secrets.

## Runtime flow

```text
packaged product profile
  -> Electron Main validates the non-secret contract
  -> installation identity + local bearer
  -> user selects workspace
  -> managed local daemon
  -> bootstrap broker provisions installation-scoped tunnel
  -> ChatGPT personal plugin connects to Public MCP with No Auth
```

The renderer does not receive provider tokens, Cloudflare credentials, or the local bearer.

`desktop/scripts/materialize-product-profile.mjs` reads `desktop/.env` only for packaging/bootstrap values such as the broker URL. SourceNerve account/OAuth settings are not part of the Desktop contract.
