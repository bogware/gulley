# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report privately via GitHub's "Report a vulnerability" (Security Advisories) on this
repository, or email the maintainers. We aim to acknowledge within 3 business days.

## Handling secrets

Gulley never stores provider credentials or tokens in the repository or in its
configuration store. Only AWS Secrets Manager ARNs (and versions) are persisted; secret
values are resolved at runtime. If you believe a secret has been committed, treat it as
compromised, rotate it immediately, and notify the maintainers.

## Scope

Gulley's core security invariants — deterministic fail-closed auth, SSRF egress lockdown,
always-on credential scrubbing, and a tamper-evident (hash-chained, optionally WORM-mirrored
and KMS-signed) audit trail — are documented in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Supported versions: the latest release on the
default branch. Please report against `main`.
