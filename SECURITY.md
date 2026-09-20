# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report privately through GitHub's
[Report a vulnerability](https://github.com/bogware/gulley/security/advisories/new)
form (Security Advisories) on this repository. We aim to acknowledge within 3 business
days.

## Handling secrets

Gulley never stores provider credentials or tokens in the repository or in its
configuration store. Only AWS Secrets Manager ARNs (and versions) are persisted; secret
values are resolved at runtime. If you believe a secret has been committed, treat it as
compromised, rotate it immediately, and notify the maintainers.

## Release images

The published images (`ghcr.io/bogware/gulley`, `ghcr.io/bogware/gulley-web`) are
distroless, Trivy-scanned before they are pushed, and cosign-signed with SBOM + SLSA
provenance attestations. Verify the signature by digest before running one — the
commands are in [`docs/SUPPLY_CHAIN.md`](docs/SUPPLY_CHAIN.md).

## Scope

Gulley's core security invariants — deterministic fail-closed auth, SSRF egress lockdown,
always-on credential scrubbing, and a tamper-evident (hash-chained, optionally WORM-mirrored
and KMS-signed) audit trail — are documented in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Supported versions: the latest release on the
default branch. Please report against `main`.
