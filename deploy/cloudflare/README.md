# SourceNerve production transport — Cloudflare Tunnel

The public SourceNerve MCP endpoint is served from the local SourceNerve process through a remotely managed Cloudflare Tunnel. No VPS reverse proxy, public origin IP, inbound port-forwarding, Caddy, Nginx, or Certbot is required.

```text
ChatGPT / Codex / SourceNerve Desktop
  -> https://sourcenerve.fogewise.io.vn
  -> Cloudflare
  -> Cloudflare Tunnel
  -> cloudflared on the SourceNerve host
  -> http://127.0.0.1:7331
  -> SourceNerve
```

Keep the SourceNerve listener private:

```toml
[server]
bind = "127.0.0.1:7331"
```

For the remotely managed tunnel, configure the public hostname:

```text
Hostname: sourcenerve.fogewise.io.vn
Service type: HTTP
Service URL: http://127.0.0.1:7331
```

Install and run `cloudflared` as a system service using the token issued by the Cloudflare dashboard. The tunnel token is a credential: never commit it to this repository, docs, CI, or SourceNerve config.

## API hostname must not use browser challenges

`sourcenerve.fogewise.io.vn` is an API/OAuth-resource hostname, not a browser-only website. SourceNerve Desktop, ChatGPT/Codex MCP clients, deployment probes, and other API clients cannot solve Cloudflare HTML/JavaScript challenge pages.

Cloudflare must allow machine-to-machine requests for the SourceNerve API surface. In particular, these endpoints must reach SourceNerve without a Cloudflare Managed/Interactive Challenge:

```text
/healthz
/readyz
/v1/desktop/client-config
/v1/desktop/enroll
/v1/desktop/bootstrap-status
/v1/desktop/tunnel/rotate
/v1/desktop/revoke
/.well-known/oauth-protected-resource/mcp
/mcp
```

If Cloudflare Security Events shows a challenge for this hostname:

- for WAF custom/managed rules, Super Bot Fight Mode, Browser Integrity Check, or Security Level, create a zone-level Skip/exception rule for `http.host eq "sourcenerve.fogewise.io.vn"` and skip the applicable challenge-producing features;
- if a custom rule itself applies `Managed Challenge`, ensure the API-host Skip rule is evaluated before that rule and skips the remaining matching custom rules;
- Bot Fight Mode cannot be bypassed by a WAF Skip rule. If Bot Fight Mode challenges SourceNerve API traffic, disable Bot Fight Mode for the zone or use a Cloudflare configuration that supports API exceptions.

Do not put Cloudflare Access or another browser-login/challenge layer in front of the SourceNerve API hostname. SourceNerve/Auth0 owns application authentication.

A valid public bootstrap response must be machine-readable JSON:

```bash
curl -i https://sourcenerve.fogewise.io.vn/v1/desktop/client-config
```

Expected: HTTP `200` with `application/json`. A `403` HTML page such as `Just a moment...` is a deployment failure and prevents first-boot Desktop sign-in because Auth0 client configuration cannot be loaded.

The tunnel must pass the client `Authorization` header through unchanged. Do not inject `SOURCENERVE_BEARER_TOKEN` at Cloudflare and do not place a second authentication gateway in front of `/mcp` that consumes or rewrites the Auth0 bearer token. SourceNerve itself is the OAuth resource server.

After SourceNerve and `cloudflared` are running:

```bash
curl -fsS http://127.0.0.1:7331/healthz | jq
curl -fsS http://127.0.0.1:7331/v1/desktop/client-config | jq
curl -fsS https://sourcenerve.fogewise.io.vn/healthz | jq
curl -fsS https://sourcenerve.fogewise.io.vn/v1/desktop/client-config | jq
curl -fsS https://sourcenerve.fogewise.io.vn/.well-known/oauth-protected-resource/mcp | jq
curl -i https://sourcenerve.fogewise.io.vn/mcp
```

The last request should return `401` with a `WWW-Authenticate: Bearer` challenge that includes SourceNerve's protected-resource metadata URL.

For public plugin publication, also verify:

```bash
bash ./scripts/verify-plugin-submission.sh
```
