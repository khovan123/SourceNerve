# Desktop Bootstrap Broker

The SourceNerve VPS is a control plane only. It provisions installation-scoped Cloudflare routing for Desktop data-plane daemons and does not host repository MCP traffic.

## Flow

```text
Desktop installationId
  -> POST /v1/desktop/enroll
  -> control plane creates/reuses installation routing
  -> Desktop receives only its tunnel run credential + hostname
  -> cloudflared forwards https://<installation-host>.fogewise.io.vn/mcp
     to the local Desktop daemon on 127.0.0.1:7331
```

Enrollment, rotation, revoke, and status are installation-based. No SourceNerve account provider or OAuth token is required.

The broker keeps Cloudflare account credentials on the VPS. Desktop receives only the credential scoped to its installation. Repository workspaces and Git provider credentials stay on Desktop.

## Public MCP

The personal SourceNerve connector uses **No Auth**. ChatGPT is configured with the installation-specific MCP URL returned by Desktop. The central control-plane origin is never a repository data plane and must not expose a central `/mcp` route.

## Security boundary

- installation IDs are generated locally and validated before broker mutations;
- installation hostnames are opaque and deterministic from the installation identity;
- Cloudflare account-level API credentials never leave the VPS;
- GitHub/GitLab credentials never reach the broker;
- the control plane has no repository workspace configuration;
- revoking or rotating one installation does not mutate another installation.
