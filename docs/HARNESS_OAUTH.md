# Coding-harness OAuth: Claude Code & Codex through the gateway broker

Gulley's **gateway-brokered OAuth** lets a developer's coding agent (Claude Code,
Codex, or any custom harness) authenticate to the data plane with a short-lived,
revocable, identity-bound token instead of a static virtual key. This page is the
end-to-end runbook: what the broker exposes, how an agent gets a token, and how an
admin approves and revokes access.

## How it fits together

```
developer machine                         control plane (broker)              data plane
─────────────────                         ──────────────────────              ──────────
gulley login ──► POST /oauth/device_authorization ──► code + verification URL
   │                                                    │
   │  user opens <console>/oauth/device, signs in, approves the code (consent is
   │  bound to the signed-in admin identity; RBAC: key:create on the client's workspace)
   │                                                    │
   └── polls POST /oauth/token (device_code) ◄──────────┘ ──► gko_at_ + gko_rt_
                                                              (family stored in Postgres;
                                                               only HMAC hashes at rest)
Claude Code apiKeyHelper ─┐
Codex [auth] command      ├─► gulley token ─► prints gko_at_ (refreshes via gko_rt_) ─► Authorization: Bearer gko_at_… ─► gateway
```

- **Broker** = the control-api (`OAUTH_BROKER_ENABLED=true` + `DATABASE_URL` +
  `GULLEY_KEY_PEPPER`). It publishes RFC 8414 metadata at
  `/.well-known/oauth-authorization-server`, RFC 8628 device authorization, PKCE
  auth-code, refresh-token rotation with **reuse detection** (a replayed superseded
  refresh token revokes the whole family and raises an `oauth.refresh_reuse` audit
  event), and RFC 7009 revocation. Every endpoint accepts
  `application/x-www-form-urlencoded` (the RFC wire format) and JSON.
- **Gateway** verifies `gko_at_` tokens read-only against the shared grant table
  (`OAUTH_BROKER_ENABLED=true` on the gateway too, same pepper). The token is accepted
  on `Authorization: Bearer` **or** `x-api-key` — the reserved prefix selects the mode,
  never the header, and a miss is a generic 401 with no fall-through to virtual keys.
- **Consent page**: `<console>/oauth/device` (the Next.js console) when
  `CONSOLE_PUBLIC_URL` is set, else the control-api's own minimal page at
  `<control-api>/oauth/device`. Both preview which client / workspace is asking, then
  approve or deny. The approver's identity (SSO session or admin token) is what the
  grant is bound to.

## 1. Admin: enable the broker and register a client

```sh
# control-api AND gateway
OAUTH_BROKER_ENABLED=true
# control-api: its own public URL (the issuer) and the console's (consent page)
CONTROL_API_PUBLIC_URL=https://api.gulley.acme.internal
CONSOLE_PUBLIC_URL=https://gulley.acme.internal
```

(The Terraform module always sets the two public URLs from the stack's DNS names and
turns on `OAUTH_BROKER_ENABLED` for both planes with `enable_oauth_broker = true`.)

Register the client in the console — **Identity → OAuth broker → Register a client**
— or with the API:

```sh
curl -sS -X POST "$API/admin/oauth/clients" -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{
    "clientId": "claude-code", "name": "Claude Code",
    "orgId": "<org uuid>", "workspaceId": "<workspace uuid>",
    "grantTypes": ["device_code", "refresh_token"], "redirectAllowlist": []
  }'
```

The org/workspace must exist durably (create them in the console, via
`config-apply`, or the seed script). Tokens minted for this client are scoped to that
workspace: its budgets, rate limits, model policy, and audit attribution apply.

## 2. Developer: install the CLI and sign in

```sh
# from the monorepo (or `npm i -g` / `pnpm link --global` from packages/cli)
pnpm gulley login --broker https://api.gulley.acme.internal --client claude-code
#   Open:  https://gulley.acme.internal/oauth/device?user_code=WXYZ-1234
#   Code:  WXYZ-1234
#   Sign in with your organization account and confirm the code. Waiting…
# ✓ signed in — profile "claude-code" saved to ~/.gulley/credentials.json
```

`gulley token --profile claude-code` then prints a valid access token, refreshing it
through the broker ahead of expiry (`--force-refresh` forces one). A cross-process,
pid-aware lock file next to the credentials serializes concurrent helper invocations so
two agent sessions never replay the same refresh token (a crashed holder is reclaimed,
a live one never evicted); the credentials file is written atomically with mode 0600;
the broker's discovered endpoints are cached in the profile (6 h) and every broker call
carries a 10 s deadline. `gulley status` shows the profiles (never the secrets);
`gulley logout` revokes the family at the broker (and says so if the broker could not
be reached) and deletes the local credential; logging in again over an existing profile
revokes the previous family first. `GULLEY_CREDENTIALS` overrides the file location
(default `~/.gulley/credentials.json`).

## 3. Point the agent at the gateway

Generate the exact config from the console (**Identity → Onboarding**, agent + "OAuth
(device login)") or `GET /admin/workspaces/:id/client-config?agent=…&auth=oauth`, or
hand the developer a **signed onboarding pack** (`…/onboarding-pack?auth=oauth`) they
apply with `gulley init pack.json --pubkey org.pem` (merges into an existing settings
file; verifies the Ed25519 signature first).

**Claude Code** (`.claude/settings.json`):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://gulley.acme.internal",
    "CLAUDE_CODE_API_KEY_HELPER_TTL_MS": "300000"
  },
  "apiKeyHelper": "gulley token --profile claude-code"
}
```

> Why a helper and not `env.ANTHROPIC_AUTH_TOKEN`? Claude Code does **not** expand
> `${VAR}` inside settings `env`, and a settings value overrides a shell export — so a
> placeholder there is sent literally and fails forever. `apiKeyHelper` is the
> documented rotating-credential hook; its output is sent as both `Authorization:
Bearer` and `x-api-key`, both of which the gateway accepts for `gko_at_`.

**Codex** (`~/.codex/config.toml`):

```toml
model_provider = "gulley"

[model_providers.gulley]
name = "Gulley"
base_url = "https://gulley.acme.internal/openai/v1"
wire_api = "responses"
stream_idle_timeout_ms = 300000

[model_providers.gulley.auth]
command = "gulley"
args = ["token", "--profile", "codex"]
timeout_ms = 10000
refresh_interval_ms = 300000
```

> `wire_api` must be `responses` — current Codex has no `chat` variant for custom
> providers (the whole file fails to parse with it). The gateway serves
> `/openai/v1/responses` natively.

For a static **virtual key** instead (CI, service accounts) the same generators emit
`env`-only configs and tell the developer to `export ANTHROPIC_AUTH_TOKEN=gk_…` /
`GULLEY_API_KEY=gk_…` — a secret is never written into a settings file.

## 4. Operate

- **Revoke**: Identity → OAuth broker → Active grants → Revoke (or
  `POST /admin/oauth/grants/:handle/revoke`). The access token is rejected on the
  gateway's next lookup; the refresh token is dead. `gulley token` introspects its
  cached token on every call (RFC 7662), so the agent's next helper run (≤ 5 min)
  reports "run `gulley login`" instead of handing over a dead token.
- **Deprovisioned user**: with Entra Graph credentials configured
  (`ENTRA_GRAPH_CLIENT_ID/SECRET`) the broker checks `accountEnabled` at every refresh
  and revokes on a disabled/deleted account.
- **Theft signal**: `GET /admin/security/refresh-reuse` lists families auto-revoked
  because a superseded refresh token was replayed.
- **Retention**: expired device/auth codes are swept every
  `OAUTH_EPHEMERA_SWEEP_INTERVAL_SECONDS`.
- **TTLs**: `OAUTH_ACCESS_TTL_MS` (1h), `OAUTH_REFRESH_TTL_MS` (30d),
  `OAUTH_ABSOLUTE_TTL_MS` (90d), `OAUTH_DEVICE_CODE_TTL_MS` (15m).

## Endpoint reference

| Endpoint                                      | Auth          | Purpose                                                                                                         |
| --------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /.well-known/oauth-authorization-server` | none          | RFC 8414 metadata (+ `device_verification_uri`)                                                                 |
| `POST /oauth/device_authorization`            | none          | RFC 8628 §3.1 — returns `verification_uri(_complete)`                                                           |
| `GET /oauth/device`                           | page          | Consent page (console has a richer one)                                                                         |
| `GET /oauth/device/preview?user_code=`        | admin session | Which client / workspace is asking                                                                              |
| `POST /oauth/device/authorize` · `/deny`      | admin session | Consent decision (audited)                                                                                      |
| `POST /oauth/token`                           | none          | `urn:ietf:params:oauth:grant-type:device_code` (or `device_code`), `authorization_code` (S256), `refresh_token` |
| `POST /oauth/revoke`                          | none          | RFC 7009 (always 200; needs cryptographic proof)                                                                |
| `POST /oauth/introspect`                      | none          | RFC 7662 for the access token you hold (`active`)                                                               |
| `GET /oauth/authorize`                        | admin session | Auth-code + PKCE (loopback redirects only)                                                                      |
