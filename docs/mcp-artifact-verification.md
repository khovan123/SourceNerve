# MCP artifact verification

SourceNerve treats cryptographic artifact provenance as a separate signal from behavioral trust and policy approval. A valid checksum or signature does not make an MCP extension safe, automatically permitted, or exempt from the SourceNerve gateway, sandbox, tool policy, OAuth, and audit boundaries.

## Supported verification path

For an Official MCP Registry entry that resolves to an exact npm package version, Desktop Main re-fetches the exact npm version metadata and downloads the registry-declared tarball before activation. SourceNerve verifies the strongest supported Subresource Integrity digest in `dist.integrity` (`sha512`, `sha384`, then `sha256`) against the downloaded bytes. A mismatch blocks install/update before the candidate can be activated.

PyPI, arbitrary stdio commands, and remote Streamable HTTP servers do not currently expose a single package artifact that SourceNerve can verify with the same byte-for-byte contract. These paths are reported as `unsupported`; SourceNerve does not infer cryptographic trust from marketplace presence or transport security.

## Publisher signatures

A package may additionally declare SourceNerve artifact signature metadata:

```json
{
  "artifactVerification": {
    "signatureRequired": true,
    "signature": {
      "algorithm": "ed25519",
      "publisher": "Acme",
      "keyId": "acme-release-2026",
      "value": "<base64 signature>",
      "required": true
    }
  }
}
```

Signatures are accepted only when Desktop Main has a reviewed matching trust root in `SOURCENERVE_MCP_PUBLISHER_TRUST_ROOTS`:

```json
{
  "schemaVersion": 1,
  "roots": [
    {
      "keyId": "acme-release-2026",
      "publisher": "Acme",
      "registryNames": ["acme/*"],
      "algorithm": "ed25519",
      "publicKeySpki": "<base64 DER SPKI public key>"
    }
  ]
}
```

A trust root binds a key ID, publisher identity, and allowed MCP registry-name patterns. SourceNerve fails closed when required signature evidence is missing, malformed, untrusted, or invalid.

The signed payload is canonical UTF-8 text:

```text
SourceNerve MCP artifact signature v1
registry=<registry name>
version=<exact version>
digest=<algorithm>-<base64 digest>
```

The signature therefore binds the publisher claim to the exact verified package digest and version.

## Update and rollback

Marketplace update review verifies the candidate artifact before the existing registration is replaced. Once activation succeeds, SourceNerve stores the new verification evidence as the current evidence and retains the previous version evidence alongside the rollback snapshot. A rollback swaps runtime version and cryptographic provenance evidence together. If evidence persistence cannot complete, SourceNerve attempts to restore the previous runtime/evidence alignment instead of silently claiming verification for the wrong version.

Verification evidence is persisted through the existing OS-backed Desktop secure store and is schema-validated and bounded. It contains digest/signature metadata only; raw credentials, OAuth tokens, tool arguments, and tool results are not part of the verification record.

## UI semantics

Desktop presents three distinct concepts:

- **Behavioral trust / marketplace provenance**: registry status, namespace/package ownership signals, repository metadata, and organization governance.
- **Artifact digest**: whether SourceNerve verified exact package bytes against a declared digest.
- **Publisher signature**: whether an optional publisher signature verified against an explicitly reviewed SourceNerve trust root.

`verified` means the stated cryptographic check succeeded. It never means the extension is behaviorally safe or automatically approved to execute tools.
