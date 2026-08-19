# SourceNerve ChatGPT / Codex plugin packaging

SourceNerve ships one MCP runtime: the Rust Streamable HTTP endpoint at `/mcp`. The package under `plugins/sourcenerve/` adds plugin discovery metadata and the guarded repository-change skill; it does not start or proxy a second MCP server.

## Public architecture

```text
ChatGPT / Codex
  -> SourceNerve plugin
  -> OAuth connection
  -> https://sourcenerve.fogewise.io.vn/mcp
  -> Cloudflare Tunnel
  -> SourceNerve on 127.0.0.1:7331
  -> authorized local workspace + server-side Git/provider credentials
```

The production `.mcp.json` contains only the public HTTPS MCP URL. It does not contain or reference the legacy shared operator bearer token. OAuth protected-resource discovery, Auth0 OIDC, and per-user `[[oauth.grant]]` entries authorize public MCP users.

## Package layout

```text
plugins/sourcenerve/
  .codex-plugin/plugin.json
  .mcp.json
  .mcp.local.json
  assets/
    icon.png
    logo.png
  skills/
    repository-change-workflow/
      SKILL.md
```

`plugin.json` is the package entry point and includes production website, privacy, terms, starter prompts, and brand assets. `.mcp.json` points to the production OAuth MCP endpoint. `.mcp.local.json` preserves the localhost/operator-bearer configuration for controlled local development only.

## Local development

From the SourceNerve repository:

```bash
cd /home/khovan/Workplaces/SourceNerve
cargo build --release
./target/release/sourcenerve
```

When deliberately testing the legacy private/operator transport, use the values from `.mcp.local.json` and make `SOURCENERVE_BEARER_TOKEN` available to the local authoring client. Do not copy that bearer configuration into the public package or public submission.

The repo marketplace remains at `.agents/plugins/marketplace.json` for authoring/testing. Local marketplace distribution is separate from the universal public Plugin Directory.

## Production OAuth MCP

The public MCP resource is:

```text
https://sourcenerve.fogewise.io.vn/mcp
```

Expected unauthenticated behavior:

```text
HTTP 401
WWW-Authenticate: Bearer resource_metadata="https://sourcenerve.fogewise.io.vn/.well-known/oauth-protected-resource/mcp", scope="sourcenerve:read"
```

Protected-resource metadata advertises the configured Auth0 issuer and the `sourcenerve:read` / `sourcenerve:write` scopes. Authenticated access still grants nothing until the exact OIDC subject has a matching server-side workspace grant.

## Publication package

The repository contains all versioned material needed to fill the OpenAI public submission:

- `plugins/sourcenerve/.codex-plugin/plugin.json` — listing/package metadata;
- `plugins/sourcenerve/assets/` — publication logo and composer icon;
- `plugins/sourcenerve/skills/repository-change-workflow/SKILL.md` — bundled workflow skill;
- `docs/plugin-tool-review.md` — annotation values and reviewer justification for every MCP tool;
- `docs/plugin-submission.md` — listing copy, reviewer-account requirements, domain verification, starter prompts, five positive tests, three negative tests, release notes, and portal checklist;
- public `/privacy`, `/terms`, `/support`, and `/` pages served by SourceNerve;
- `/.well-known/openai-apps-challenge` — exact-token domain-verification route controlled by `SOURCENERVE_OPENAI_APPS_CHALLENGE`;
- `scripts/verify-plugin-submission.sh` — deployment preflight.

## Tool metadata and safety

`src/mcp_plugin.rs` decorates every current MCP tool with explicit `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` semantics. The test suite requires current public tools to remain explicitly classified. SourceNerve deliberately labels status-like task/provider calls as non-read-only when they can persist lifecycle observations.

Plugin metadata never relaxes the server authority model:

- no arbitrary shell endpoint;
- no force push, reset, or raw refspec;
- no direct default-branch commit;
- patches remain exact-HEAD + per-file SHA guarded;
- commits remain reviewed-diff-SHA guarded;
- pushes remain non-force and branch-scoped;
- provider merges remain exact-head guarded and subject to provider checks/reviews/protection;
- public OAuth writes require write scope + exact read-write grant + writable workspace;
- repository-host and Git credentials remain server-side.

The bundled skill additionally instructs the client not to call merge unless the user explicitly requests it.

## Domain verification

Do not commit an OpenAI challenge token. When the submission portal gives the exact value:

```bash
export SOURCENERVE_OPENAI_APPS_CHALLENGE='EXACT_TOKEN_FROM_PORTAL'
```

Restart SourceNerve and verify:

```bash
curl -fsS https://sourcenerve.fogewise.io.vn/.well-known/openai-apps-challenge
```

The body must contain exactly that one token and no JSON wrapper. The route returns `404` when the variable is absent or invalid.

## Preflight after deployment

```bash
cd /home/khovan/Workplaces/SourceNerve
bash ./scripts/verify-oauth-deployment.sh
bash ./scripts/verify-plugin-submission.sh
```

If the OpenAI challenge is active, keep `SOURCENERVE_OPENAI_APPS_CHALLENGE` exported when running the plugin preflight so it verifies exact-token equality.

## Submission and publication

The OpenAI Platform submission itself is a publisher action, not a Git commit. The submitter must use a verified developer/business identity, supply reviewer OAuth credentials only in the portal, complete the policy attestations, select intended availability, and submit the draft for review. `docs/plugin-submission.md` is the copy/paste runbook for those fields.

After approval, SourceNerve can appear in the universal Plugin Directory shared by ChatGPT and Codex. Directory visibility does not by itself guarantee installation or invocation on every plan; actual availability depends on the published capability, plan, surface, region, and account/workspace settings.
