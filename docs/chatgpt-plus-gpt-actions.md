# ChatGPT Plus integration with GPT Actions

SourceNerve keeps MCP as its primary agent transport, but ChatGPT Plus does not currently support custom full-MCP apps. A Plus account can instead use a **Custom GPT with GPT Actions** against SourceNerve's existing authenticated REST API.

This integration does not weaken SourceNerve's mutation contract. The GPT Action calls the same `/api/v1/*` routes used by other clients, so exact Git HEAD, file SHA-256, reviewed-diff SHA, feature-branch, non-force push, provider-head and branch-protection guards remain authoritative.

## Architecture

```text
ChatGPT Plus Custom GPT
        |
        | GPT Action / HTTPS / Bearer API key
        v
public HTTPS origin (for example ngrok)
        |
        v
SourceNerve 127.0.0.1:7331
        |
        +-- /gpt-actions/openapi.json   public schema only
        +-- /api/v1/*                  bearer protected
        +-- /mcp                       bearer protected
```

## 1. Run SourceNerve with a stable bearer token

Use a stable secret instead of generating a different token on every restart:

```bash
cd /home/khovan/Workplaces/SourceNerve
export SOURCENERVE_CONFIG="$PWD/sourcenerve.toml"
export SOURCENERVE_BEARER_TOKEN='<strong-stable-secret>'
./target/release/sourcenerve
```

The bearer token is not embedded in the GPT Actions schema and must not be committed to this repository.

## 2. Publish the local HTTP server through HTTPS

Example with ngrok:

```bash
ngrok http 7331
```

If the public origin is:

```text
https://example.ngrok-free.dev
```

then the GPT Actions schema is:

```text
https://example.ngrok-free.dev/gpt-actions/openapi.json
```

The schema endpoint derives its `servers[0].url` from the reverse proxy's forwarded HTTPS host, so the imported action points back to the same public SourceNerve origin.

Verify:

```bash
curl -fsS https://example.ngrok-free.dev/gpt-actions/openapi.json | jq '.servers'
```

Expected shape:

```json
[
  {
    "url": "https://example.ngrok-free.dev",
    "description": "The public SourceNerve origin that served this schema"
  }
]
```

## 3. Create a Custom GPT

Open the GPT builder in ChatGPT and create a private GPT for SourceNerve.

Under **Actions**:

1. Select **Create new action**.
2. Import the schema from the public URL above, or paste its JSON contents.
3. Configure **Authentication** as **API key**.
4. Select **Bearer** authentication.
5. Enter the same value configured as `SOURCENERVE_BEARER_TOKEN`.
6. Test `listWorkspaces` or `getReadiness` in Preview before enabling mutation actions in a workflow.

The bearer token is stored in the GPT Action authentication configuration; it does not need to be injected by ngrok.

## 4. Recommended GPT instructions

Keep the GPT's workflow conservative. A suitable instruction baseline is:

```text
Use SourceNerve as the repository authority.
Always inspect workspace state and exact Git HEAD before proposing a change.
Read every touched existing file and use the returned full-file SHA-256 in patch expectations.
Preview a patch before applying it.
After applying, call Git review and use the returned exact diff SHA-256 for commit.
Never force push, reset, bypass provider checks, or merge without reading the current pull-request head SHA.
Do not automatically merge a pull request unless the user explicitly requested merge.
If SourceNerve reports stale HEAD, stale file hashes, dirty state, changed review diff, or provider-head mismatch, stop and refresh state instead of guessing.
```

## Exposed GPT Actions

The initial Plus-compatible schema exposes the bounded workflow needed for repository analysis and guarded GitHub delivery:

- workspace list and readiness
- workspace index and repository snapshot
- code search and file read
- graph status and bounded context pack
- patch preview and guarded patch apply
- Git review
- guarded feature-branch checkout
- exact reviewed commit
- non-force feature-branch push
- fast-forward-only default-branch sync
- GitHub issue creation
- GitHub pull-request create/get/guarded merge

The MCP surface remains unchanged and continues to expose the broader SourceNerve tool set for clients that support MCP.

## Security notes

- Only the OpenAPI schema endpoint is public. `/api/v1/*` and `/mcp` remain bearer protected.
- Do not configure ngrok to inject the SourceNerve bearer token when GPT Actions is using Bearer API-key authentication; otherwise anyone who knows the tunnel URL could inherit the injected credential.
- Keep the GPT private unless there is a deliberate sharing/review decision.
- Public GPTs with Actions require a valid privacy policy URL under ChatGPT publishing rules.
- GPT Actions may ask for user approval before sending data or taking actions.
- GPT Actions are not available while using ChatGPT **Pro mode**; use a model/mode that supports Actions.
- SourceNerve never treats the GPT as trusted enough to bypass repository concurrency or provider authorization checks.

## ngrok example for the current development machine

For a public origin such as:

```text
https://flanked-shredding-theatrics.ngrok-free.dev
```

import:

```text
https://flanked-shredding-theatrics.ngrok-free.dev/gpt-actions/openapi.json
```

and configure the Action authentication as **API key -> Bearer** using the SourceNerve bearer token.
