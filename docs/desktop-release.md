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

## Protected `desktop-release` environment

Create the GitHub Actions environment `desktop-release` and configure protection rules before any stable tag is pushed. Use required reviewers and restrict deployment to the stable Desktop tag pattern. Set environment variable `SOURCENERVE_RELEASE_ENVIRONMENT_PROTECTED=true`; release jobs fail closed when this sentinel is absent.

The following profile values belong in protected **environment variables** because they are public product identifiers/endpoints but must still change through the reviewed release process:

- `SOURCENERVE_AUTH0_NATIVE_CLIENT_ID`
- `SOURCENERVE_GITHUB_OAUTH_CLIENT_ID`
- `SOURCENERVE_GITLAB_OAUTH_CLIENT_ID`
- `SOURCENERVE_BOOTSTRAP_BROKER_URL`

The current bootstrap design does **not** embed a Cloudflare account token, one shared tunnel credential, Git provider user token, Auth0 user session, local bearer, workspace data, or SSH credential in a release. Installation-scoped Cloudflare credentials are issued by the bootstrap broker at runtime and the local bearer is generated uniquely per installation.

Signing/notarization material belongs only in protected **environment secrets**. macOS packaging consumes `SOURCENERVE_MACOS_SIGN_IDENTITY`, `SOURCENERVE_APPLE_ID`, `SOURCENERVE_APPLE_ID_PASSWORD`, and `SOURCENERVE_APPLE_TEAM_ID`. Windows certificate material is owned by the signing work in #82. The release pipeline independently verifies Authenticode before publication, so setting a readiness flag cannot bypass an unsigned Windows build.

Do not put protected secret values in repository variables, committed `.env` files, workflow literals, renderer configuration, source maps, or release notes.

## Pipeline and publish behavior

A stable tag performs these gates:

1. Rust format, clippy, and tests.
2. Desktop dependency/security audit, release contract, typecheck, and unit tests.
3. Four native build legs: Fedora x64, Windows x64, macOS arm64, macOS x64.
4. Protected product-profile materialization.
5. Native daemon + Electron package/installer build.
6. Packaged payload, secret-canary, and installer-set verification.
7. Value-based scan of tracked source and generated renderer/main/preload bundles against protected release secrets supplied to the job.
8. Updater manifest generation from final package bytes and checksum verification.
9. macOS signature/Gatekeeper verification and Windows Authenticode verification.
10. Aggregate checksum/version/profile verification across all four artifact groups.
11. GitHub Release publication.

Each native leg uploads its `out/make` artifacts to GitHub Actions with 14-day retention before the signing verification step. This intentionally preserves diagnostic artifacts when a signing gate fails. The publish job receives `contents: write`; validation and native build jobs remain read-only.

Publication is draft-first. The workflow creates a draft release, uploads all verified artifacts/manifests with collision checks, and only then makes the stable release public. A rerun may repair an existing **draft** release. The workflow refuses to overwrite an already-published stable release.

## Failed platform leg and rerun

If one platform leg fails before publication:

1. Open the failed `Desktop Stable Release` run and inspect that platform job.
2. Use **Re-run failed jobs** (or rerun the single failed job) so successful platform legs are not rebuilt unnecessarily.
3. Keep the original tag unchanged when the failure is transient and no source change is required.
4. If source/workflow code must change, fix it on `main`, bump to a new patch version, and create a new `desktop-vX.Y.Z` tag. Do not move a published stable tag to a different commit.
5. Use retained Actions artifacts for diagnosis; they are not public release assets unless the final publish gate succeeds.

If publication itself fails after a draft was created, rerun the failed publish job. It may clobber assets on the draft and then publish it. If the release is already public, the job fails rather than mutating stable bytes.

## Update or state recovery

Desktop, bundled daemon, and product-profile compatibility remain one release unit. A stable release must not ship a daemon independently. User workspace/state and OS secure-store records live outside the application install directory and are preserved across installer replacement. If a candidate release cannot pass packaged smoke, version/profile verification, signing, or updater manifest verification, the stable release is not published and the previously installed release remains the recovery point.

## Credential rotation

For public OAuth client IDs or the bootstrap broker URL, update the provider/broker configuration first, change the protected environment variable, build a new stable patch release, and verify the new profile before retiring the previous value.

For installation-scoped Public MCP/Cloudflare credentials, rotate through the authenticated bootstrap broker path; never replace them with a release-wide credential. The Desktop secure store persists the new credential before the tunnel restarts, as covered by the #77 rotation regression test.

For macOS or Windows signing credentials, add the replacement to the protected `desktop-release` environment, produce and verify a new release, then revoke the old signing credential according to the issuing platform's process. Never print, commit, or copy signing secrets into release artifacts.
