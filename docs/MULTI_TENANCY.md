# Multi-tenancy

The `org → workspace → project` spine is present throughout (branded ids in
`@gulley/core`, columns on every durable table), so a request is always scoped to
a tenant via its principal. Much per-tenant isolation is therefore already in
place; this document records what is enforced and what a request's tenant boundary
means.

## What a tenant is

A **workspace** (within an **org**) is the tenant boundary. Every principal —
virtual key, JWT, Basic, OIDC admin — resolves to a `scope { orgId, workspaceId,
allowedProviders, allowedModels }`. That scope is the tenant identity carried
through the whole pipeline.

## Isolation that already holds

- **Budgets & rate limits** are keyed by `workspaceId` (Redis counters + the
  Postgres `budget`/`rate_limit` tables), enforced per request. One tenant can't
  spend another's budget or exhaust its rate window.
- **Metering & audit** rows carry `orgId`/`workspaceId`; the hash-chained audit
  trail is org-scoped.
- **Cache** is partitioned by authz scope, so a cached response never crosses a
  tenant boundary.
- **RBAC** scopes the control plane: an admin sees/administers only the orgs their
  memberships cover (`coveredOrgIds`, `coversWorkspace`), and a config apply is
  authorized per affected org.
- **Config** is modeled `org → workspace → { providers, routes, … }`, so config is
  inherently per-tenant in the document + the durable tables.

## Per-tenant upstream credentials (the isolation this adds)

The defining multi-tenant capability: **one gateway fronts many tenants, each
authenticating to the provider with its OWN key.** In DB config mode
(`CONFIG_SOURCE=db`), a `DbTenantCredentialResolver` resolves the serving
provider's credential for the request's workspace (Postgres `provider` +
`provider_credential`, ARN → value via the `SecretResolver`, cached with a TTL);
the gateway forwards upstream with that tenant's key, falling back to the
gateway's default (env/route) credential when a tenant has none — so single-tenant
deployments are unchanged. Tests cover the mechanism with an in-memory
`MapTenantCredentialResolver`; the DB resolver is exercised live.

## What a fuller multi-tenant mode would still add

- Per-tenant **provider ROUTING** (not just credentials): a tenant could route the
  same client path to a different provider/model. The route table is currently
  shared; tenant credentials are the first, highest-value step.
- Hard **noisy-neighbor** controls: per-tenant concurrency caps and priority
  (the breaker/outlier/scoreboard are per-target, not per-tenant).
- Per-tenant **data residency** / at-rest key separation, and per-tenant OTLP /
  log routing.

These are additive on the existing spine — none requires a schema migration of the
tenant boundary itself.
