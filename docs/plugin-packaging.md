# SourceNerve ChatGPT / Codex plugin packaging

SourceNerve ships one MCP runtime: the Rust Streamable HTTP endpoint at `/mcp`. The package under `plugins/sourcenerve/` adds plugin discovery metadata plus three bundled skills: the guarded repository-change workflow, the default Karpathy-inspired coding guidelines, and the ChatGPT planning/review loop. It does not start or proxy a second MCP server.

## Public architecture

```text
ChatGPT / Codex
  -> SourceNerve skills package
  -> installation-specific MCP connection copied from SourceNerve Desktop
  -> https://<installation-host>.fogewise.io.vn/mcp
  -> Cloudflare Tunnel
  -> Desktop SourceNerve data plane on 127.0.0.1:7331
  -> authorized local workspace + server-side Git/provider credentials
```

The distributable plugin package deliberately does **not** contain a production `.mcp.json`. A single static remote MCP URL would incorrectly bind every installation to the central control-plane origin. Desktop enrollment owns the per-installation hostname and the **Copy ChatGPT setup fields** action supplies the exact MCP Server URL.

## Package layout

```text
plugins/sourcenerve/
  .codex-plugin/plugin.json
  .mcp.local.json
  assets/
    icon.png
    logo.png
  skills/
    chatgpt-review-loop/
      SKILL.md
    karpathy-guidelines/
      SKILL.md
    repository-change-workflow/
      SKILL.md
```

`plugin.json` is the package entry point and includes production website, privacy, terms, starter prompts, brand assets, and the bundled skills. It intentionally has no `mcpServers` declaration. `.mcp.local.json` preserves a localhost/operator-bearer example for controlled local development only and is not referenced by the distributable manifest.

## Local development

From the SourceNerve repository:

```bash
cd /home/khovan/Workplaces/SourceNerve
cargo build --release
./target/release/sourcenerve
```

When deliberately testing the legacy private/operator transport, use the values from `.mcp.local.json` and make `SOURCENERVE_BEARER_TOKEN` available to the local authoring client. Do not copy that bearer configuration into the public package or public submission.

The repo marketplace remains at `.agents/plugins/marketplace.json` for authoring/testing. Local marketplace distribution is separate from the universal public Plugin Directory.

## Production personal MCP

Each Desktop installation exposes its own MCP transport URL:

```text
https://<installation-host>.fogewise.io.vn/mcp
```

The SourceNerve ChatGPT connector uses **No Auth**. Desktop owns the installation-scoped Cloudflare tunnel and local daemon; no external identity provider is involved.

## Publication package

The repository contains all versioned material needed to fill the OpenAI public submission:

- `plugins/sourcenerve/.codex-plugin/plugin.json` — listing/package metadata;
- `plugins/sourcenerve/assets/` — publication logo and composer icon;
- `plugins/sourcenerve/skills/chatgpt-review-loop/SKILL.md` — optional Goal/Loop planner/reviewer protocol for using ChatGPT through the strict read-only review connector while Codex/Harness owns execution;
- `plugins/sourcenerve/skills/karpathy-guidelines/SKILL.md` — bundled default coding-behavior skill, adapted from `multica-ai/andrej-karpathy-skills` under MIT;
- `plugins/sourcenerve/skills/repository-change-workflow/SKILL.md` — bundled SourceNerve workflow skill;
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
- workspace write operations remain bounded by the configured local workspace access and existing mutation guards;
- repository-host and Git credentials remain server-side.
- `/mcp?mode=review` is a stricter capability surface: only the explicit read-only planning/review allowlist is advertised and every non-allowlisted call is rejected before the Harness tool pipeline.

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
SOURCENERVE_PLUGIN_MCP_URL='https://<installation-host>.fogewise.io.vn/mcp' \
  bash ./scripts/verify-plugin-submission.sh
# In ChatGPT: Authentication = No Auth
```

If the OpenAI challenge is active, keep `SOURCENERVE_OPENAI_APPS_CHALLENGE` exported when running the plugin preflight so it verifies exact-token equality.

## Submission and publication

The OpenAI Platform submission itself is a publisher action, not a Git commit. The submitter must use a verified developer/business identity, prepare the disposable reviewer test setup, complete the policy attestations, select intended availability, and submit the draft for review. `docs/plugin-submission.md` is the copy/paste runbook for those fields.

After approval, SourceNerve can appear in the universal Plugin Directory shared by ChatGPT and Codex. Directory visibility does not by itself guarantee installation or invocation on every plan; actual availability depends on the published capability, plan, surface, region, and account/workspace settings.
