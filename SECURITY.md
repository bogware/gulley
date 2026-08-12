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

A full threat model and control mapping (SOC 2 Type II) lands with the security-hardening
milestone (see [`docs/ROADMAP.md`](docs/ROADMAP.md), M6). Core invariants — deterministic
fail-closed auth, SSRF egress lockdown, always-on credential scrubbing, tamper-evident
audit — are documented in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
