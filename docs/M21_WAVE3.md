# M21 — Wave 3: "DX & adoption"

The moat (Waves 1–2) is deep; Wave 3 lowers the barrier to adopting it. Same
per-slice discipline: implement → focused tests → `bash ci/verify.sh` green →
commit `-s` → push. Hot-path-file slices carry a `Hotpath-Reviewed:` trailer.

Scope (from `docs/AGENTGATEWAY_PORT.md` "Wave 3 — DX & adoption"):

| Slice | What                                                                                                       | Status |
| ----- | ---------------------------------------------------------------------------------------------------------- | ------ |
| **A** | In-console **playground preflight API** — "does my key/route/model work?" with no upstream call/spend.     | ✅     |
| **B** | Governed **prompt registry** — versioned, audited, hash-chained prompt templates on the GitOps/RBAC rails. | ⏳     |
| **C** | Full **admin CRUD** — PUT/DELETE for the config resources that were create/read-only.                      | ⏳     |
| **D** | Published **OpenAPI** spec + a typed control-API client package.                                           | ⏳     |
| **E** | **Helm chart / one-command deploy** — the one image running either plane.                                  | ⏳     |
| **F** | **Compliance-as-a-product** — the audit-verify CLI + an auditor attestation export.                        | ⏳     |

## A — Playground preflight API ✅

`POST /v1/playground/verify` (gateway). The first-run unlock: an authenticated
caller sends a sample request and gets back exactly what the data plane _would_
do — **without proxying or spending**:

- **authn** — the caller's virtual key (a real key check).
- **model** — router alias/pin resolution (`requested` → `resolved`).
- **authz** — `modelAllowed` + `providerAllowed` (candidate selection under the
  key's provider scope).
- **route** — the target that would serve it (`name` / `provider` / `upstreamPath`).
- **guardrails** — input findings + categories + `wouldBlock` under the input policy.
- **cost** — the worst-case estimate, priced by the same catalog resolver the
  admission reserve uses (no reserve/commit disagreement).
- **budget** — a real would-admit answer via a reserve-then-release **peek**
  (`commit(scope, id, 0)` rolls the reservation back; zero net spend).

`ok` is the AND of: model allowed, a permitted target exists, guardrails wouldn't
block, and the budget (if capped) would admit. Reuses the real pipeline
components so the answer is faithful; a real streamed request still goes through
`/v1/messages` (and the `live:*` smoke scripts). Audited as `playground.verify`
(no content). Gated by `PLAYGROUND_ENABLED` (default on) — off ⇒ 404. As a static
`POST` route it wins over the `/*` proxy dispatcher. 6 gateway integration tests.

_Design note:_ the endpoint lives in the data plane (not control-api) because a
faithful answer needs the live route table, guardrail engine, cost resolver, and
budget store — all already assembled on the gateway context.
