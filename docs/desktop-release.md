# Desktop stable release runbook

SourceNerve Desktop stable releases are produced only by `.github/workflows/desktop-release.yml` from an immutable tag named `desktop-vX.Y.Z`.

## Version contract

`desktop/package.json` is the release version source of truth. Before creating a tag:

1. Set `desktop/package.json` to the intended stable `X.Y.Z` version.
2. Set the root `Cargo.toml` package version to the same `X.Y.Z` value.
3. Keep the product bootstrap profile on the stable channel and a supported integer `schemaVersion`.
4. Run `npm run release:contract` from `desktop/`.
5. Merge all required changes to `main`, then create `desktop-vX.Y.Z` at that exact main commit.

The release workflow rejects prerelease-like versions, a mismatched daemon version, a non-stable profile, or a tag that does not exactly match the Desktop version.

## Runtime configuration

Stable Desktop packages do not embed account-provider configuration. The personal SourceNerve connector uses No Auth and obtains only installation routing from the bootstrap broker. Git provider credentials and the local bearer remain runtime-only values and are never baked into release artifacts.

## Protected `desktop-release` environment

Create the GitHub Actions environment `desktop-release` and configure protection rules before any stable tag is pushed. Use required reviewers and restrict deployment to the stable Desktop tag pattern. Set `SOURCENERVE_RELEASE_ENVIRONMENT_PROTECTED=true`; release jobs fail closed when this sentinel is absent.

The only product-profile deployment value that packaging must materialize is the Bootstrap Broker URL. The workflow writes it to `desktop/.env` and `desktop/scripts/materialize-product-profile.mjs` reads that file directly:

```dotenv
SOURCENERVE_BOOTSTRAP_BROKER_URL=https://sourcenerve.fogewise.io.vn
```

Do not use shell `export KEY=VALUE` instructions for Desktop product configuration. The build materializer does not use shell environment variables as its configuration source.

The current bootstrap design does **not** embed a Cloudflare account token, shared tunnel credential, Git provider user token, local bearer, workspace data, or SSH credential in a release. Installation-scoped Cloudflare credentials are issued by the bootstrap broker at runtime and the local bearer is generated uniquely per installation.

Stable packages are intentionally buildable and publishable without code-signing or notarization credentials. Signing/notarization may be added later as an optional hardening layer, but it is not part of the artifact build contract and no signing secret is required by the stable workflow.

## Pipeline and publish behavior

A stable tag performs these gates:

1. Rust format, clippy, and tests.
2. Desktop dependency/security audit, release contract, typecheck, and unit tests.
3. Four native build legs: Fedora/Linux x64 (RPM + AppImage), Windows x64 (NSIS), macOS arm64 (DMG + ZIP), and macOS x64 (DMG + ZIP). These artifacts are unsigned/non-notarized by default.
4. Write the reviewed Bootstrap Broker URL to an ephemeral `desktop/.env` and materialize the product profile.
5. Native daemon + Electron package/installer build on each platform's matching runner.
6. Packaged payload, secret-canary, and installer-set verification.
7. Scan tracked source and generated renderer/main/preload bundles for release secret leakage and unresolved release canaries.
8. Updater manifest generation from final package bytes and checksum verification.
9. Aggregate checksum/version/profile verification for all four native artifact groups.
10. GitHub Release publication.

Each native leg uploads its `out/make` artifacts to GitHub Actions with 14-day retention. The publish job receives `contents: write`; validation and native build jobs remain read-only.

Publication is draft-first. The workflow creates a draft release, uploads all verified artifacts/manifests with collision checks, and only then makes the stable release public. A rerun may repair an existing **draft** release. The workflow refuses to overwrite an already-published stable release.

## Failed platform leg and rerun

If any native release leg fails before publication:

1. Inspect the failed platform job.
2. Re-run the failed job(s) so successful native legs are not rebuilt unnecessarily.
3. Keep the original tag unchanged when the failure is transient and no source change is required.
4. If source/workflow code must change, fix it on `main`, bump to a new patch version, and create a new `desktop-vX.Y.Z` tag. Do not move a published stable tag.
5. Retained Actions artifacts are diagnostic only until the final publish gate succeeds.

## Configuration rotation


Changing the Bootstrap Broker URL itself requires a new Desktop build because that URL is the bootstrap location required to discover the server-managed configuration.

Installation-scoped Public MCP/Cloudflare credentials rotate through the authenticated broker path. Optional future signing credentials, if enabled, must remain CI-only and require a new verified release.
