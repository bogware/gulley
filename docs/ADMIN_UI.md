# Gulley Admin Console — Build Plan

The control-plane UI (`apps/web`), built on the control-api endpoints that already
exist.

> **Status: ✅ DELIVERED.** The pages below are built and the app builds clean
> (`next build`). Auth supports both a **bootstrap/paste-token** flow (dev /
> break-glass) and **Entra SSO** ("Sign in with SSO" — see
> [ENTRA_SETUP.md](ENTRA_SETUP.md)). `pnpm --filter @gulley/web dev` serves it;
> `/control/*` proxies to the control-api (`CONTROL_API_URL`, default :8081) — read at
> **request time** by `app/control/[...path]/route.ts`, so one console image serves any
> environment (the value is a runtime env, not a build arg).

## Stack

- **Next.js 15 (App Router) + React 19 + Tailwind** (already set up). Add
  primitives (button, table, dialog, card, badge, tabs) and a lightweight chart
  approach — inline SVG / a small charting lib. Keep it dependency-light.
- **Data layer:** `apps/web/lib/api.ts` (`GulleyAdminApi`) + `lib/types.ts` DTOs,
  mirroring the control-api responses. Base URL from `NEXT_PUBLIC_CONTROL_API_URL`.

## Auth flow (dependency)

The console authenticates against the control-api with an **admin session bearer
token**. In production that token is minted by the **Entra OIDC login → admin
session** gate (auth-code + PKCE; see [ENTRA_SETUP.md](ENTRA_SETUP.md)). For dev or
break-glass, a **bootstrap admin token** is pasted into the console (kept in
`sessionStorage` for the tab's lifetime — never `localStorage` — and sent as
`Authorization: Bearer`). Any `401` from the control-api signs the console out again
and shows why; every call carries a 15 s deadline.

## Routes / pages

| Route                                     | Purpose                                                                                 | Backing API (built)                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `/`                                       | Dashboard: spend + usage tiles, recent requests                                         | `/admin/analytics/usage`, `/admin/logs`            |
| `/logs`                                   | Request-log browser: filter (provider/model/status/time), keyset paginate, row → detail | `/admin/logs`, `/admin/logs/:id`                   |
| `/analytics`                              | Time-bucketed spend/token charts, split by provider/model                               | `/admin/analytics/usage`                           |
| `/keys`                                   | Mint / view / revoke virtual keys (token shown once)                                    | `POST /keys`, `GET /keys/:id`                      |
| `/providers`                              | Providers + secret-ref credentials                                                      | `GET/POST /providers`, `/providers/:id/credential` |
| `/orgs`                                   | Org → workspace tree                                                                    | `GET/POST /orgs`, `/workspaces`                    |
| `/budgets`, `/rate-limits`, `/guardrails` | Per-workspace policy config collections                                                 | `GET/POST /budgets`, `/rate-limits`, `/guardrails` |
| `/routes`                                 | Routing strategies + model aliases (_planned — needs a routes read API_)                | `GET/POST /routes`, `/model-aliases`               |
| `/audit`                                  | Verify the hash-chained audit log                                                       | `GET /audit/verify`                                |

## Components

- **AppShell** — sidebar nav + top bar (workspace switcher, token status).
- **StatTile / SpendTile** — KPI cards (total spend, requests, tokens, error rate)
  from the usage rollup.
- **UsageChart** — area/bar over `UsageBucket[]` (endpoint emphasized), theme-aware.
- **LogTable** — server-driven table with the filter bar and a "load more" cursor
  button (the API returns `nextCursor`); a row opens a **LogDetail** drawer.
- **ConfigCollection** — a generic create/list panel reused by budgets / rate-limits
  / guardrails (they share the `{ workspaceId, name, config }` shape).
- **KeyMintDialog** — mint → show the token once with a copy button, then never again.

## Data-fetching pattern

The admin token is client-held (a session), so pages are **client components** that
call `GulleyAdminApi`. Wrap fetches in a small `useAdminQuery` hook (loading/error/
data + refetch). Keep mutations (mint key, create provider) optimistic-free and
re-fetch on success. All reads are already RBAC-scoped server-side to the caller's
visible workspaces, so the UI shows only what the token may see.

## First slice to build

1. **AppShell + token gate** (paste/verify against `GET /audit/verify` or `GET /orgs`).
2. **Dashboard** (spend/usage tiles + recent 10 logs) — proves the data layer.
3. **Log browser** with filters + cursor pagination + detail drawer.
4. **Analytics** charts.
5. Config CRUD panels (keys, providers, budgets, rate-limits, guardrails).

Then wire the OIDC session (M11) to replace the pasted token.
