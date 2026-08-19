# SourceNerve production transport — Cloudflare Tunnel

The public SourceNerve MCP endpoint is served from the local SourceNerve process through a remotely managed Cloudflare Tunnel. No VPS reverse proxy, public origin IP, inbound port-forwarding, Caddy, Nginx, or Certbot is required.

```text
ChatGPT / Codex
  -> https://sourcenerve.fogewise.io.vn/mcp
  -> Cloudflare
  -> Cloudflare Tunnel
  -> cloudflared on the SourceNerve host
  -> http://127.0.0.1:7331/mcp
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

The tunnel must pass the client `Authorization` header through unchanged. Do not inject `SOURCENERVE_BEARER_TOKEN` at Cloudflare and do not place a second authentication gateway in front of `/mcp` that consumes or rewrites the Auth0 bearer token. SourceNerve itself is the OAuth resource server.

After SourceNerve and `cloudflared` are running:

```bash
curl -fsS http://127.0.0.1:7331/healthz | jq
curl -fsS https://sourcenerve.fogewise.io.vn/healthz | jq
curl -fsS https://sourcenerve.fogewise.io.vn/.well-known/oauth-protected-resource/mcp | jq
curl -i https://sourcenerve.fogewise.io.vn/mcp
```

The last request should return `401` with a `WWW-Authenticate: Bearer` challenge that includes SourceNerve's protected-resource metadata URL.

For public plugin publication, also verify:

```bash
bash ./scripts/verify-plugin-submission.sh
```
