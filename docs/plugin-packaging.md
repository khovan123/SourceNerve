# SourceNerve ChatGPT / Codex plugin packaging

SourceNerve uses one MCP runtime: the existing Rust Streamable HTTP endpoint at `/mcp`. The plugin package in `plugins/sourcenerve/` adds discovery, workflow guidance, and local marketplace wiring; it does not start or proxy a second MCP server.

## Architecture

```text
ChatGPT / Codex
  -> SourceNerve plugin package
  -> existing SourceNerve /mcp
  -> AppState / SQLite repository intelligence
  -> guarded Git + repository-host lifecycle
```

## Local development

From the SourceNerve repository:

```bash
cd /home/khovan/Workplaces/SourceNerve
export SOURCENERVE_CONFIG="$PWD/sourcenerve.toml"
export SOURCENERVE_BEARER_TOKEN='<stable-development-token>'
./target/release/sourcenerve
```

When the Rust source has changed, rebuild first:

```bash
cargo build --release
```

The bundled plugin MCP configuration points to:

```text
http://127.0.0.1:7331/mcp
```

and reads its bearer token from `SOURCENERVE_BEARER_TOKEN`. Keep that environment variable available to the ChatGPT desktop/Codex process that loads the plugin.

The repository exposes a local marketplace at `.agents/plugins/marketplace.json`. Add the repository as a developer marketplace using the current ChatGPT/Codex plugin authoring UI or CLI, then install the `sourcenerve` plugin from that marketplace. Restart/reload the client when required so it rescans the package.

## Remote MCP development with ngrok

For remote transport testing, SourceNerve may remain bound to `127.0.0.1:7331` while ngrok exposes HTTPS:

```text
https://flanked-shredding-theatrics.ngrok-free.dev/mcp
```

The ngrok hostname is a development endpoint, not the recommended public listing URL. The Rust server remains the same `/mcp` implementation whether reached directly, through ngrok, or through a production reverse proxy.

The current SourceNerve server-wide bearer token is appropriate for controlled private/development usage. Do not remove MCP authentication or inject a public shared token merely to make remote discovery easier.

## Registered ChatGPT app mapping

Do not commit a guessed `.app.json` or fake OpenAI technical app ID. After an MCP connection is registered and OpenAI provides the actual technical identifier (for example an ID in the `plugin_asdk_app...` family), an authoring environment may generate or maintain an `.app.json` mapping to that real app.

Until then, this repository-owned package uses `.mcp.json` to connect directly to the existing SourceNerve MCP server.

## Public submission readiness

Before submitting SourceNerve for public distribution:

1. Deploy the existing `/mcp` endpoint on a stable public HTTPS domain. Use ngrok only for development/testing.
2. Complete the public OAuth 2.1/MCP authorization milestone tracked in issue #50. The server-wide shared bearer token is not the final public multi-user authorization contract.
3. Complete domain verification, including the requested `/.well-known/openai-apps-challenge` response when the submission flow supplies a challenge value.
4. Prepare listing metadata and assets: name, description, icon/logo, screenshots where required, support URL, privacy policy URL, and terms URL.
5. Scan the MCP server and verify every exposed tool has accurate human-readable descriptions and safety annotations.
6. Prepare at least representative positive and negative test prompts, including read-only analysis and guarded mutation behavior.
7. Verify mutation prompts cannot bypass SourceNerve's exact HEAD, file SHA, review diff SHA, provider-head, and branch-protection guards.
8. Verify no absolute workspace paths, bearer/provider tokens, raw secrets, or sensitive webhook payloads appear in MCP responses.

## Build behavior

Changes only to plugin JSON/Markdown packaging do not alter the SourceNerve binary. Changes to `src/mcp.rs` or any other Rust source do, so after pulling a release that contains MCP metadata changes run:

```bash
cargo build --release
```

before restarting `target/release/sourcenerve`.

## Security boundary

Plugin packaging does not change SourceNerve's authority model:

- no arbitrary shell endpoint;
- no force push, reset, or raw refspec;
- no direct default-branch commit;
- patches remain HEAD + per-file SHA guarded;
- commits remain reviewed-diff-SHA guarded;
- provider merges remain exact-head guarded and subject to provider checks/reviews/protection;
- repository-host and Git credentials remain server-side.
