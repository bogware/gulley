# M21 — Wave 3: "DX & adoption"

The moat (Waves 1–2) is deep; Wave 3 lowers the barrier to adopting it. Same
per-slice discipline: implement → focused tests → `bash ci/verify.sh` green →
commit `-s` → push. Hot-path-file slices carry a `Hotpath-Reviewed:` trailer.

Scope (from `docs/AGENTGATEWAY_PORT.md` "Wave 3 — DX & adoption"):

| Slice | What                                                                                                       | Status |
| ----- | ---------------------------------------------------------------------------------------------------------- | ------ |
| **A** | In-console **playground preflight API** — "does my key/route/model work?" with no upstream call/spend.     | ✅     |
| **B** | Governed **prompt registry** — versioned, audited, hash-chained prompt templates on the GitOps/RBAC rails. | ✅     |
| **C** | Full **admin CRUD** — PUT/DELETE for the config resources that were create/read-only.                      | ✅     |
| **D** | Published **OpenAPI** spec + a typed control-API client package.                                           | ✅     |
| **E** | **Helm chart / one-command deploy** — the one image running either plane.                                  | ✅     |
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

## C — Full admin CRUD ✅

The workspace-scoped config collections (routes / policies / budgets / rate-limits
/ guardrails / model-aliases) were create + read only; the key-lifecycle endpoints
(disable/rotate) landed in M19 F. This slice closes the lifecycle:

- `PUT /{collection}/:id` — update name and/or config (the same inline-secret guard
  as create), scope resolved from the **stored** entity's workspace (never the
  request body, so an orgId can't be forged); `422` when no fields are supplied.
- `DELETE /{collection}/:id` — delete on `resource:delete`.
- `DELETE /providers/:id` and `DELETE /workspaces/:id` — providers and workspaces
  had create + read but no delete; the lifecycle is now complete.

Every write goes through the shared `auditedWrite` (deny-by-default RBAC → mutate →
hash-chained audit row), so the new verbs are governed and audited exactly like
create. 5 control-api integration tests (round-trip update+delete, 404s, empty-
patch 422, provider + workspace delete).

## D — Published OpenAPI + typed client ✅

`@gulley/control-client` — a dependency-free, typed client for the control-plane
admin API, and the published OpenAPI 3.1 document that describes it:

- **`controlApiOpenApi`** (`src/openapi.ts`) is the single source of truth — 32
  paths across tenancy / providers / keys / config collections / the prompt
  registry / GitOps apply / audit verify, each operation tagged, uniquely
  `operationId`'d, and bearer-secured (`/health` public). `scripts/emit-openapi.ts`
  serializes it to `docs/openapi/control-api.json` (manual/idempotent, per the
  no-scheduled-automation rule) for distribution + codegen.
- **`ControlClient`** — a typed `fetch` wrapper: `createOrg`, `createWorkspace`,
  `mintKey`/`rotateKey`/`disableKey`, the generic collection CRUD, the full prompt
  registry (`createPrompt`/`addPromptVersion`/`renderPrompt`/`verifyPromptChain`),
  `applyConfig`, `verifyAudit`. Sends the admin bearer token, encodes path/query
  params, omits a body+content-type on GET/DELETE (so it never trips the server's
  empty-JSON-body 400), and throws `ControlApiError{status, body}` on non-2xx.

8 package tests: the client's verb/path/header/encoding/error behavior (mock
fetch) and the OpenAPI document's structural invariants (unique operationIds, all
tags declared, path params match `{…}`, collection CRUD + prompt registry covered,
public-vs-secured split).

## E — Helm chart / one-command deploy ✅

Deployment artifacts under `deploy/` so the moat can be self-hosted in one step:

- **`deploy/docker-compose.prod.yml`** — one command brings up both planes plus
  Postgres and the role-split Redis trio (cache `allkeys-lru`; counters + vector
  `noeviction`, matching the eviction-policy invariant). Both app services run the
  **one image** with a plane-selecting `command`; secrets come from `deploy/.env`.
- **`deploy/helm/gulley/`** — a Helm chart: a shared ConfigMap (non-secret env),
  ServiceAccount (IRSA-annotatable), the gateway Deployment + Service + optional
  HPA, and the control-api Deployment + Service. `/ready` gates traffic until routes
  are wired; SIGTERM drives the bounded drain (`terminationGracePeriodSeconds`);
  hardened pod/container securityContext (non-root, read-only rootfs + a `/tmp`
  emptyDir). `values.schema.json` validates inputs. **Secret VALUES never live in
  the chart** — only the name of an `existingSecret` you supply (secret-ARNs-only
  ethos carried to Kubernetes).

Validated by **`bash ci/helm-check.sh`** — a dedicated no-cloud gate (mirrors
`ci/tf-check.sh`, not part of `ci/verify.sh`): a Node validator parses every
plain-YAML manifest + the JSON schema and asserts the structural invariants
(single image + plane commands, Redis eviction policies, required chart values,
balanced `{{ }}` in every template); if `helm` is on PATH it also `helm lint`s and
`helm template`s the chart (default + control-api-disabled). Helm templates are
Go-templated YAML, so they're excluded from Prettier.
