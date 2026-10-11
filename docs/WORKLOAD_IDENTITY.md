# Workload identity: Kubernetes and GitHub Actions → scoped gateway tokens

Agents and services that run in a cluster or a CI job have no human to consent for
them and should not carry a static `gk_` virtual key. **Workload identity federation**
lets them exchange the credential their platform already gives them — a Kubernetes
service-account token, a GitHub Actions OIDC token — for a short-lived, **scoped**,
**access-only** Gulley token bound to a **service principal**:

```
POST /oauth/token
grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer    (RFC 7523)
assertion=<the platform's JWT>
[client_id=<registered client>]                            (optional)

→ { "access_token": "gko_at_…", "token_type": "Bearer", "expires_in": 3600 }
```

The gateway then treats `gko_at_…` exactly like any brokered token: resolved read-only
against the grant store with the shared key pepper, deny-by-default scope, metered and
audited under the principal `svc:<federation>:<subject>`.

## How it works

```
 pod / job ── platform JWT ──► POST /oauth/token (jwt-bearer) ──► control-api
                                                                   │  1. route by `iss` to a federation
                                                                   │  2. JWKS signature (RS/PS/ES only)
                                                                   │  3. iss · aud · exp · nbf · iat ≤ 10 min
                                                                   │  4. jti replay guard
                                                                   │  5. subject pattern / claims
                                                                   ▼
                                           oauth_grant row: kind=service, scope=<federation scope>,
                                           NO refresh token, absolute expiry = access expiry
                                                                   │
 pod / job ◄── gko_at_ (expires_in = ttlSeconds) ◄─────────────────┘
      │
      └── Authorization: Bearer gko_at_… ──► gateway ──► Principal { id: "svc:<fed>:<sub>",
                                                                   serviceAccount: "<fed>",
                                                                   onBehalfOf, scope }
```

- **A federation is a trust configuration**, not a client: it names the issuer, which
  subjects are admitted, and the tenancy + scope they receive. The platform's JWKS is
  fetched through the control plane's SSRF/air-gap egress guard and DNS-pinned fetch
  (public issuers) and cached per issuer with the same TTL / single-flight /
  unknown-`kid` refresh / serve-stale behaviour as the OIDC session gate.
- **Verification is strict.** Asymmetric signatures only (`none` and HMAC are rejected
  outright), `iss` must equal the federation's issuer, `aud` must contain the broker's
  public origin (or the federation's configured audience), `exp`/`nbf` with 60 s skew,
  **`iat` is required and may be at most 10 minutes old**, and a `jti` is remembered so
  the same assertion cannot be exchanged twice (a token without `jti` is keyed by its
  signature).
- **The grant is access-only.** No refresh token is minted; a refresh attempt against
  a service family is `invalid_grant` and touches no state. The workload simply
  presents a fresh platform token when it needs a new gateway token (both platforms
  mint them on demand).
- **Every failure is one generic `400 invalid_grant`.** The reason
  (`unknown-issuer`, `aud`, `iat-stale`, `replayed`, `subject-mismatch`, …) goes to the
  control-api log under `event: oauth.jwt_bearer_rejected`; the assertion is never
  logged or echoed.
- **Every success is audited** as `oauth.token_exchanged` (actor = the service
  principal, payload = federation, subject, client, workspace, expiry).

## Trust configuration: `WORKLOAD_FEDERATIONS`

A JSON array on the control-api, validated with zod at boot (a malformed entry fails
startup). Empty or unset = the grant type is off and not advertised.

```jsonc
[
  {
    "name": "gh-api-main", // [A-Za-z0-9._-], unique; part of the principal id
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": { "pattern": "repo:acme/api:ref:refs/heads/main" },
    "orgId": "<org uuid>",
    "workspaceId": "<workspace uuid>",
    "scope": { "allowedProviders": ["anthropic"], "allowedModels": ["claude-sonnet-4-6"] },
    "ttlSeconds": 900,
  },
  {
    "name": "gh-prod-env",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": { "claims": { "repository": "acme/api", "environment": "prod" } },
    "orgId": "<org uuid>",
    "workspaceId": "<workspace uuid>",
  },
  {
    "name": "k8s-prod",
    "issuer": "https://kubernetes.default.svc",
    "jwksUri": "https://kubernetes.default.svc/openid/v1/jwks",
    "allowInternal": true,
    "audience": "https://gulley-control.acme.internal",
    "subject": {
      "pattern": "system:serviceaccount:prod:*",
      "claims": { "kubernetes.io/namespace": "prod" },
    },
    "orgId": "<org uuid>",
    "workspaceId": "<workspace uuid>",
    "scope": { "groups": ["prod-agents"] },
    "onBehalfOf": true,
    "displayName": "prod cluster agents",
  },
]
```

| Field                  | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                 | Short handle; the principal id is `svc:<name>:<sub>` (a `sub` over 200 chars is shortened and suffixed with a hash).                                                                                                                                                                                                                                                                                                      |
| `issuer`               | The assertion's `iss`, verbatim (a trailing slash is tolerated). Several federations may share an issuer; the first whose subject rule admits the token wins.                                                                                                                                                                                                                                                             |
| `jwksUri`              | Where the signing keys live. Default: `jwks_uri` from `<issuer>/.well-known/openid-configuration`, read **leniently** (only `issuer` + `jwks_uri` are required — GitHub and Kubernetes publish no authorization/token endpoints).                                                                                                                                                                                         |
| `audience`             | Accepted `aud` value(s). Default: the broker's public origin (`CONTROL_API_PUBLIC_URL`, else the proxy-trusted request origin) — the URL the workload asked its platform to mint a token for.                                                                                                                                                                                                                             |
| `allowInternal`        | Permit an in-cluster / RFC 1918 JWKS host (a Kubernetes API server on its cluster IP). The SSRF egress guard and the DNS-pinned fetch are bypassed **for this federation's URLs only**. Default `false`. If the API server uses the cluster CA, point `NODE_EXTRA_CA_CERTS` at it.                                                                                                                                        |
| `subject`              | `pattern`: a `:`-segmented glob — `*` matches exactly one segment, `**` the remainder (`system:serviceaccount:prod:*` admits every service account of one namespace; `repo:acme/api:**` any ref or environment of one repo). `claims`: exact matches on the listed claims (an array = any of; a `/` path such as `kubernetes.io/namespace` reads a nested claim). Both apply when both are set; at least one is required. |
| `orgId`, `workspaceId` | The tenancy every token of this federation is scoped to.                                                                                                                                                                                                                                                                                                                                                                  |
| `scope`                | `allowedProviders` / `allowedModels` (`'*'` or a list, default `'*'`) and optional `groups` tags (per-group config such as smart routing — never authz). Stored on the grant verbatim and returned by `/oauth/introspect`.                                                                                                                                                                                                |
| `ttlSeconds`           | Access-token lifetime. Default 3600, maximum 86400.                                                                                                                                                                                                                                                                                                                                                                       |
| `onBehalfOf`           | May this principal assert an end user per request (see below)? Default `false`.                                                                                                                                                                                                                                                                                                                                           |
| `displayName`          | The principal's display name (default `<name>: <sub>`).                                                                                                                                                                                                                                                                                                                                                                   |

Production requires `https://` issuers and JWKS endpoints (checked at config load).
Public issuers (GitHub, a managed cluster's OIDC issuer such as
`https://oidc.eks.<region>.amazonaws.com/id/…`) must be on `OUTBOUND_HOST_ALLOWLIST`
when the control plane is air-gapped.

### `client_id` is optional

A JWT-bearer exchange needs no registered client: the **federation** decides tenancy
and scope, and the grant is recorded under the built-in pseudo-client `workload`
(which exists for no other purpose and can mint nothing else). You may name a
registered client instead — it must be enabled, carry the grant type
`urn:ietf:params:oauth:grant-type:jwt-bearer` in the console's client registry, and
belong to the same org/workspace as the federation (else `401 invalid_client`). Use
that when you want the console's per-client grant listing to group a fleet's tokens.

## Kubernetes: projected service-account token with an audience

Default service-account tokens are minted for the API server's own audience; project
one for the broker so `aud` matches (the federation's `audience`, or the broker's
public origin when unset):

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: coding-agent
  namespace: prod
spec:
  serviceAccountName: builder
  containers:
    - name: agent
      image: ghcr.io/acme/agent:latest
      env:
        - name: GULLEY_CONTROL_URL
          value: https://gulley-control.acme.internal
        - name: ANTHROPIC_BASE_URL
          value: https://gulley.acme.internal
      volumeMounts:
        - name: gulley-token
          mountPath: /var/run/secrets/gulley
          readOnly: true
  volumes:
    - name: gulley-token
      projected:
        sources:
          - serviceAccountToken:
              path: token
              audience: https://gulley-control.acme.internal # = the federation audience
              expirationSeconds: 600 # the broker rejects an iat older than 10 min anyway
```

The kubelet rotates the projected token on its own; exchange it each time you need a
gateway token:

```bash
export ANTHROPIC_AUTH_TOKEN="$(gulley token exchange \
  --control "$GULLEY_CONTROL_URL" --k8s-sa --token-path /var/run/secrets/gulley/token)"
```

The federation `issuer` is the cluster's service-account issuer
(`kubectl get --raw /.well-known/openid-configuration | jq -r .issuer` — in-cluster
`https://kubernetes.default.svc`, or the public OIDC issuer of a managed cluster). For
an in-cluster issuer set `allowInternal: true` and make sure anonymous discovery is
allowed (the `system:service-account-issuer-discovery` ClusterRole is bound to
`system:unauthenticated` by default), or pin `jwksUri` to the public endpoint.

## GitHub Actions

```yaml
jobs:
  agent:
    runs-on: ubuntu-latest
    permissions:
      id-token: write # lets the job mint an OIDC token
      contents: read
    environment: prod # surfaces as the `environment` claim
    steps:
      - uses: actions/checkout@v4
      - run: npm i -g @gulley/cli
      - name: Exchange the job's OIDC token for a gateway token
        run: |
          eval "$(gulley token exchange --control https://gulley-control.acme.internal --github --env)"
          echo "::add-mask::$ANTHROPIC_AUTH_TOKEN"
          echo "ANTHROPIC_AUTH_TOKEN=$ANTHROPIC_AUTH_TOKEN" >> "$GITHUB_ENV"
      - run: claude -p "review the diff" # or any Anthropic-SDK client
        env:
          ANTHROPIC_BASE_URL: https://gulley.acme.internal
```

`--github` requests the token from `ACTIONS_ID_TOKEN_REQUEST_URL` with
`audience=<broker issuer>` (override with `--audience`). The `sub` of a GitHub token
is `repo:<owner>/<repo>:ref:refs/heads/<branch>` on a branch push,
`repo:<owner>/<repo>:environment:<env>` in an environment job, and
`repo:<owner>/<repo>:pull_request` for PRs; `repository`, `repository_owner`,
`actor`, `workflow`, `ref` and `environment` are available to a `claims` rule.

## The CLI

```
gulley token exchange --control <url>
    (--k8s-sa [--token-path <p>] | --github [--audience <aud>] | --assertion-file <path>)
    [--client <id>] [--env]
```

Prints the access token on stdout (nothing else), or `export ANTHROPIC_AUTH_TOKEN=…`
with `--env`; progress and errors go to stderr. Nothing is stored in
`~/.gulley/credentials.json` and the assertion is never printed. Exit 1 with guidance
on `invalid_grant` ("check `WORKLOAD_FEDERATIONS` and the token audience"), 2 on bad
arguments. Any RFC 7523-capable client works just as well: POST the form to
`<control url>/oauth/token`.

## End-user propagation (`x-user-id`)

Three kinds of principal reach the gateway:

| Credential                                   | `principal.userId`  | `principal.serviceAccount` | `principal.onBehalfOf`   |
| -------------------------------------------- | ------------------- | -------------------------- | ------------------------ |
| brokered **user** token (device / auth-code) | the consenting user | —                          | —                        |
| inbound IdP JWT                              | the token's `sub`   | —                          | —                        |
| brokered **service** token (this document)   | — (undefined)       | the federation name        | the federation's setting |
| virtual key / Basic                          | —                   | —                          | —                        |

A service principal is a workload, not a person. When its federation sets
`onBehalfOf: true`, the gateway **honours an `x-user-id` request header** as the end
user the workload is acting for (attribution, per-user budgets, audit); for every other
principal the header is **ignored** and `userId` stands. A federation without
`onBehalfOf` cannot impersonate anyone, whatever headers it sends. Both the service
principal and the asserted user appear in the request log and audit trail, so an
on-behalf-of request is never attributed to the user alone.

## Operate

- **Introspect**: `POST /oauth/introspect` with the token reports `kind: "service"`,
  `federation`, `subject`, `scope`, `on_behalf_of` (and `active: false` once revoked or
  expired).
- **Revoke**: `POST /oauth/revoke` with the access token, or the console / `POST
/admin/oauth/grants/:handle/revoke`. A SCIM deprovision also revokes every broker
  grant of the offboarded user's subject (user grants — a service principal is not a
  SCIM user).
- **Rate limit**: the exchange draws on `CONTROL_API_TOKEN_EXCHANGE_RATE_LIMIT_PER_MIN`
  (default 600 per source IP per minute), separate from the 60/min human-login
  budget (`CONTROL_API_AUTH_RATE_LIMIT_PER_MIN`), because a NAT'd cluster or runner
  fleet shares one address.
- **Retention**: expired service families (and user families past their absolute and
  access expiry) are deleted by the OAuth ephemera sweep every
  `OAUTH_EPHEMERA_SWEEP_INTERVAL_SECONDS` (advisory lock `5138008707`, one replica).
- **Replay guard scope**: the `jti` set is **per control-api process** (bounded to
  100 000 entries; when full, expired entries are swept and then the oldest evicted).
  Behind a load balancer a replayed assertion is rejected only by the replica that saw
  it first; the 10-minute `iat` window bounds the exposure. A shared (Redis) set is
  the cross-replica upgrade if you run many replicas and need strict single use.
- **Migration**: `0030_workload_federation` adds `kind`, `federation`, `subject`,
  `scope`, `on_behalf_of` to `oauth_grant` (existing rows read as `kind = 'user'`).
