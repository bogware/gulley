# Gulley Admin Console

The control-plane UI (`apps/web`), built on the control-api endpoints.

> **Status: ✅ DELIVERED.** The pages below are built and the app builds clean
> (`next build`). Auth supports both a **bootstrap/paste-token** flow (dev /
> break-glass) and **Entra SSO** ("Sign in with SSO" — see
> [ENTRA_SETUP.md](ENTRA_SETUP.md)). `pnpm --filter @gulley/web dev` serves it on :3000;
> `/control/*` proxies to the control-api (`CONTROL_API_URL`, default
> `http://localhost:8081`) — read at **request time** by
> `app/control/[...path]/route.ts` (streams bodies, forwards `Set-Cookie`, never
> follows upstream redirects, answers 502/504 itself; `CONTROL_API_PROXY_TIMEOUT_MS`,
> default 60 s), so one console image serves any environment (the value is a runtime
> env, not a build arg). Security headers (CSP, `nosniff`, `frame-ancestors 'none'`)
> are set in `next.config.mjs`; the container image runs Next's standalone server
> (`NEXT_STANDALONE=1` at build).

## Stack

- **Next.js 15 (App Router) + React 19 + Tailwind.** Primitives (panel, table,
  tabs, badges, stat tiles, code/JSON blocks, copy button) live in
  `components/ui.tsx`; charts are inline SVG (`components/usage-chart.tsx`). No UI
  framework dependency.
- **Data layer:** `apps/web/lib/api.ts` (`GulleyAdminApi`, typed `ApiError`) +
  `lib/types.ts` DTOs, mirroring the control-api responses. Base URL from
  `NEXT_PUBLIC_CONTROL_API_URL`, default `/control` (the same-origin proxy).

## Auth flow (dependency)

The console authenticates against the control-api with an **admin session bearer
token**. In production that token is minted by the **Entra OIDC login → admin
session** gate (auth-code + PKCE; see [ENTRA_SETUP.md](ENTRA_SETUP.md)). For dev or
break-glass, a **bootstrap admin token** is pasted into the console (kept in
`sessionStorage` for the tab's lifetime — never `localStorage` — and sent as
`Authorization: Bearer`). Any `401` from the control-api signs the console out again
and shows why; every call carries a 15 s deadline.

## Routes / pages

The sidebar (`components/app-shell.tsx`) groups the pages below; every route is
exercised by the Playwright navigation flow (`e2e/flows/navigate.spec.ts`).

| Route                      | Purpose                                                                                                                                       | Primary control-api endpoints                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `/`                        | Overview: spend + usage tiles, recent requests                                                                                                | `/admin/analytics/usage`, `/admin/logs`                                                                                         |
| `/logs`                    | Request-log browser: filter (provider/model/status/time), keyset paginate, row → detail drawer                                                | `/admin/logs`, `/admin/logs/:requestId`                                                                                         |
| `/analytics`               | Time-bucketed spend/token charts, split by provider/model                                                                                     | `/admin/analytics/usage`                                                                                                        |
| `/observability`           | Live gateway metrics snapshot (backs off while the metrics listener is down)                                                                  | `/admin/observability/metrics`, `/admin/observability/status`                                                                   |
| `/compliance`              | Audit chain verify + events, attestation, evidence bundle, WORM / anchor / SIEM status, mask-vault reveal, crypto-shred                       | `/audit/*`, `/admin/mask-vault/:requestId`, `/admin/crypto-shred/:subject`                                                      |
| `/guardrails`              | Per-workspace guardrail policy collection                                                                                                     | `/guardrails`                                                                                                                   |
| `/rollouts`                | Eval suites + eval-gated model rollouts                                                                                                       | `/admin/eval-suites`, `/admin/rollouts`                                                                                         |
| `/finops`                  | Chargeback by workspace/model/provider/attribution + shadow-spend (bypass) reconciliation                                                     | `/admin/analytics/chargeback`, `/admin/analytics/shadow-spend`                                                                  |
| `/budgets`, `/rate-limits` | Per-workspace policy collections                                                                                                              | `/budgets`, `/rate-limits`                                                                                                      |
| `/identity`                | Users & sessions, memberships, OAuth broker (clients, grants, device codes, refresh-reuse alerts), onboarding (client configs + signed packs) | `/admin/users`, `/admin/sessions`, `/memberships`, `/admin/oauth/*`, `/admin/security/refresh-reuse`, `/admin/workspaces/:id/*` |
| `/keys`                    | Mint / list / disable / rotate virtual keys (token shown once)                                                                                | `/keys`, `/keys/:id`, `/keys/:id/disable`, `/keys/:id/rotate`                                                                   |
| `/config`                  | GitOps config console: export, plan/diff, apply, drift, version history                                                                       | `/config/*`                                                                                                                     |
| `/routes`                  | Routes & model aliases — edit and hot-reload through the audited collection writes                                                            | `/routes`, `/model-aliases`                                                                                                     |
| `/providers`               | Providers + secret-ref credentials                                                                                                            | `/providers`, `/providers/:id/credential`                                                                                       |
| `/prompts`                 | Governed prompt registry: versions, render, chain verify                                                                                      | `/prompts`, `/prompts/:id/*`                                                                                                    |
| `/orgs`                    | Org → workspace tree                                                                                                                          | `/orgs`, `/workspaces`                                                                                                          |
| `/settings`                | Control-api status/version, runtime log level, config dump                                                                                    | `/admin/status`, `/admin/log-level`, `/admin/config-dump`                                                                       |
| `/oauth/device`            | Device-flow consent page (preview → approve / deny; needs a signed-in admin)                                                                  | `/oauth/device/preview`, `/oauth/device/authorize`, `/oauth/device/deny`                                                        |

## Components

- **AppShell** (`components/app-shell.tsx`) — sidebar nav + top bar with the control
  API's real version and reachability.
- **StatTile** — KPI cards (total spend, requests, tokens, error rate) from the usage
  rollup.
- **UsageChart** — inline-SVG area/bar over `UsageBucket[]`, theme-aware.
- **Log browser** — server-driven table with the filter bar and a "Load more" cursor
  button (the API returns `nextCursor`), debounced so it never fetches per keystroke
  and guards against out-of-order responses; a row opens the **LogDrawer**.
- **CollectionPage** (`components/collection-page.tsx`) — the generic list/create/
  edit/delete panel reused by budgets / rate-limits / guardrails / routes / policies
  / model aliases (they share the `{ workspaceId, name, config }` shape).
- **Key minting** — mint → show the token once with a copy button, then never again;
  rotate/disable confirm first.
- **TokenGate** — the sign-in screen: "Sign in with SSO" when `/auth/config` reports
  OIDC enabled, else the paste-token form.

## Data-fetching pattern

The admin token is client-held (a session), so pages are **client components** that
call `GulleyAdminApi` through the `useAdminQuery` hook (`lib/hooks.ts`: loading /
error / data + refetch). Mutations are optimistic-free and re-fetch on success;
destructive actions (rotate/disable key, delete org/workspace/entity/suite, revoke
session/grant/membership) confirm first; every list panel shows the real error with a
Retry. All reads are already RBAC-scoped server-side to the caller's visible
workspaces, so the UI shows only what the token may see.

## Build order (done)

1. **AppShell + token gate** (paste/verify against `GET /orgs`).
2. **Dashboard** (spend/usage tiles + recent logs) — proved the data layer.
3. **Log browser** with filters + cursor pagination + detail drawer.
4. **Analytics** charts.
5. Config CRUD panels (keys, providers, budgets, rate-limits, guardrails, routes).

The OIDC session ([ENTRA_SETUP.md](ENTRA_SETUP.md)) then replaced the pasted token
as the production sign-in; the paste flow remains for dev and break-glass.
