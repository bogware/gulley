# M21 — Wave 3: "DX & adoption"

The moat (Waves 1–2) is deep; Wave 3 lowers the barrier to adopting it. Same
per-slice discipline: implement → focused tests → `bash ci/verify.sh` green →
commit `-s` → push. Hot-path-file slices carry a `Hotpath-Reviewed:` trailer.

Scope (from `docs/AGENTGATEWAY_PORT.md` "Wave 3 — DX & adoption"):

| Slice | What                                                                                                       | Status |
| ----- | ---------------------------------------------------------------------------------------------------------- | ------ |
| **A** | In-console **playground preflight API** — "does my key/route/model work?" with no upstream call/spend.     | ✅     |
| **B** | Governed **prompt registry** — versioned, audited, hash-chained prompt templates on the GitOps/RBAC rails. | ✅     |
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

## B — Governed prompt registry ✅

`@gulley/prompts` — a dependency-free registry of **named, workspace-scoped,
versioned, hash-chained** prompt templates. Governance-native (on the existing
RBAC + audit rails), not a me-too prompt studio:

- **Versioned.** Each template is append-only; a new revision is `version + 1`.
  Bodies carry `{{ variable }}` placeholders; the declared variable set is derived
  from the body (single source of truth).
- **Hash-chained (tamper-evident).** Every version's `hash = sha256(prevHash +
canonical(body, variables))`, so editing any historical body breaks the chain
  from that point — `verifyChain` recomputes and reports `brokenAt`. Same
  discipline as the audit sink.
- **Rendered strictly.** `renderPrompt` substitutes placeholders and **throws**
  (listing every missing name) rather than shipping a half-filled governed prompt.

Wired into the control-api on the standard `adminRoute` + RBAC (`prompt:*`, a new
resource in `@gulley/rbac`) + audit rails: `POST /prompts` (v1),
`POST /prompts/:id/versions`, `GET /prompts` (workspace-scoped summaries),
`GET /prompts/:id`, `GET /prompts/:id/verify`, `POST /prompts/:id/render`,
`DELETE /prompts/:id`. Every write is hash-chain audited (`prompt.create` /
`prompt.version.create` / `prompt.delete`) with the version hash in the payload.
10 package tests + 5 control-api integration tests. _Follow-up: a Postgres adapter
plus GitOps export/import on the config document (in-memory registry today)._
