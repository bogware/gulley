# Per-agent FinOps (K5)

Gulley meters every request into the durable `spend_ledger`, tagged with the agent's
own identity headers (see "Agent attribution is zero-config" in
[ARCHITECTURE.md §7](ARCHITECTURE.md#7-cost-metering--budgets)). This document covers
what is built on top of that ledger:

1. the **agent cost tree** — spend by session → prompt → subagent, with the share
   burned on context compaction;
2. the **FOCUS 1.2 export** — every ledger row as a FinOps-Foundation-shaped record
   your cost platform can ingest;
3. the **runaway-session detector** — a baseline rule that flags, or blocks, a
   session whose spend has run away from its principal's and the deployment's norm;
4. the **session kill switch** — `session_block` rows the gateway refuses with 403.

All four are control-plane features in DB mode (`DATABASE_URL`); the routes return
`501` without a database. Reads are scoped to the caller's visible workspaces, like
chargeback.

## Attribution the views rely on

| Ledger `attributes` key | Source header (Claude Code)       | Used for                      |
| ----------------------- | --------------------------------- | ----------------------------- |
| `session`               | `x-claude-code-session-id`        | the tree's root, the kill key |
| `prompt`                | `x-claude-code-prompt-id`         | second level                  |
| `cc_agent`              | `x-claude-code-agent-id`          | subagent leaf                 |
| `cc_parent_agent`       | `x-claude-code-parent-agent-id`   | nesting                       |
| `request_class`         | `x-claude-code-request-class`     | `compaction` / `subagent`     |
| `compaction`            | `x-claude-code-compaction`        | compaction share              |
| `agent`                 | derived (`claude-code` / `codex`) | FOCUS `x_gulley_agent`        |

Operator-mapped `ATTRIBUTION_HEADERS` can populate the same keys (an operator tag wins
on a shared key), so a non-Claude harness gets the same views by sending a `session`.

**Legs.** Cascade, hedge and classifier attempts are separate ledger rows whose
request id is `<parent>#<leg>` (`#cascade-tier1`, `#hedge-timeout`, `#classify`). The
classifier leg carries no attributes; every leg is attributed to its parent request
(a self-join on the parent id), so a session's cost includes everything it caused.
`requests` counts distinct parent ids; `legs` counts rows.

## 1. Agent cost tree

`GET /admin/analytics/agent-tree?from&to&session&workspaceId`

```json
{
  "tree": [
    {
      "workspaceId": "…", "session": "…", "principalId": "vk_…",
      "firstAt": "…", "lastAt": "…",
      "requests": 41, "legs": 44, "inputTokens": 180210, "outputTokens": 9120,
      "costMicroUsd": 2140000, "cacheSavedMicroUsd": 310000,
      "compactionMicroUsd": 420000, "subagentMicroUsd": 960000,
      "prompts": [
        {
          "prompt": "…", "direct": { "…totals of the main thread" },
          "agents": [ { "ccAgent": "…", "ccParentAgent": null, "children": [ … ], "…totals" } ],
          "…totals"
        }
      ]
    }
  ],
  "rows": [ "the flat (session, prompt, cc_agent) groups the tree was built from" ],
  "truncated": false,
  "from": "…", "to": "…"
}
```

- Sessions are ordered costliest first and bounded to **10 000** per response
  (`truncated: true` when more matched — narrow the window or pass `session=`).
- `compactionMicroUsd` sums rows with `request_class = compaction` **or** a
  `compaction` tag; `subagentMicroUsd` sums rows with `request_class = subagent`.
- Subagents nest under their `cc_parent_agent` when that agent appears in the same
  prompt; otherwise they are roots of the prompt. A cycle in client data falls back to
  the root.
- The default window is the last 30 days. The expression index
  `spend_ledger_session_idx ((attributes->>'session'), created_at)` serves the
  `session=` drill-down.

Console: **FinOps → Agent tree** lists sessions with totals and the compaction share;
expand a session for prompts → subagents, and block it from the row.

## 2. FOCUS 1.2 export

`GET /admin/analytics/focus?from&to&format=csv|jsonl&cursor&workspaceId`

One ledger row = one FOCUS row (`ChargeCategory = Usage`, `ChargeFrequency =
Usage-Based`). The response is **streamed** in pages of 50 000 rows; when another page
follows, the `x-next-cursor` response header carries the continuation (pass it back
as `cursor`). The cursor is known before the body starts, so a consumer can page a
multi-million-row month without buffering. `content-disposition` names the file
`gulley-focus-<from>-<to>.csv|jsonl`. A caller with nothing visible gets a well-formed
empty document (header only), never an unscoped query.

### Columns (fixed order)

| Column                                    | Value                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| `BilledCost`, `EffectiveCost`             | `cost_micro_usd / 1e6` (USD)                                                 |
| `ListCost`                                | cost + provider-prompt-cache savings (`cache_saved_micro_usd`)               |
| `ContractedCost`                          | = `EffectiveCost`                                                            |
| `BillingCurrency`                         | `USD`                                                                        |
| `BillingAccountId` / `BillingAccountName` | org id / org name (id when unnamed)                                          |
| `SubAccountId` / `SubAccountName`         | workspace id / workspace name                                                |
| `ChargeCategory`                          | `Usage`                                                                      |
| `ChargeClass`                             | null                                                                         |
| `ChargeFrequency`                         | `Usage-Based`                                                                |
| `ChargeDescription`                       | `<provider>/<model> request`                                                 |
| `ChargePeriodStart` / `ChargePeriodEnd`   | the row's `created_at` (both)                                                |
| `BillingPeriodStart` / `BillingPeriodEnd` | the UTC calendar month containing `created_at`                               |
| `ServiceName`                             | `Gulley LLM Gateway`                                                         |
| `ServiceCategory`                         | `AI and Machine Learning`                                                    |
| `ServiceSubcategory`                      | `Generative AI`                                                              |
| `ProviderName`                            | the Gulley provider (`anthropic`, `openai`, `bedrock`, `azure`…)             |
| `PublisherName`                           | `Anthropic`, `OpenAI`, `Amazon Web Services`, `Microsoft`, else the provider |
| `InvoiceIssuerName`                       | `Gulley`                                                                     |
| `ResourceId`                              | the request id (legs keep their `#leg` suffix)                               |
| `ResourceName`                            | null                                                                         |
| `ResourceType`                            | `llm-request`                                                                |
| `RegionId` / `RegionName`                 | null (the ledger does not carry the served region)                           |
| `SkuId`                                   | the model id                                                                 |
| `SkuPriceId`                              | null                                                                         |
| `PricingCategory`                         | `Standard`                                                                   |
| `PricingQuantity` / `ConsumedQuantity`    | input + output tokens                                                        |
| `PricingUnit` / `ConsumedUnit`            | `Tokens`                                                                     |
| `ListUnitPrice`                           | null                                                                         |
| `Tags`                                    | the row's `attributes` as a JSON object                                      |

### Extension columns (`x_gulley_*`)

`x_gulley_input_tokens`, `x_gulley_output_tokens`, `x_gulley_cache_read_tokens`,
`x_gulley_cache_write_tokens`, `x_gulley_principal_id`, `x_gulley_status`,
`x_gulley_session`, `x_gulley_prompt`, `x_gulley_agent`, `x_gulley_cc_agent`,
`x_gulley_request_class`.

### Formats

- **CSV** (`text/csv`): RFC 4180 — CRLF records, fields quoted when they hold a comma,
  quote or line break, quotes doubled. Attribution values are client-supplied, so any
  string field beginning with `=`, `+`, `-`, `@`, tab or CR is prefixed with `'` —
  the same formula-injection guard the console's own CSV export applies. Numbers and
  nulls are emitted bare (null = empty field); `Tags` is one quoted JSON field.
- **JSON Lines** (`application/x-ndjson`, `format=jsonl`): one object per line, keys
  in column order, `Tags` as a nested object, costs as numbers.

Console: **FinOps → Chargeback → FOCUS export** downloads the selected range (the
console follows `x-next-cursor` and concatenates pages).

## 3. Runaway-session detector

A control-api job (`RUNAWAY_DETECTOR_INTERVAL_SECONDS`, default 300; `0` = off) that
runs on one replica per tick (advisory lock `5138008706`) in DB mode.

### The rule

For every session that spent within the last `RUNAWAY_WINDOW_MINUTES` (default 60):

```
C         = the session's total spend over the last RUNAWAY_BASELINE_DAYS (default 7)
p95       = p95 of the PRINCIPAL's per-session spend over the baseline window
            (the scope-wide p95 when the principal has fewer than 20 sessions)
baseline  = 2 × p95
runaway   ⇔ C > max(RUNAWAY_MIN_COST_USD, baseline)  AND  C > scope-wide p99
```

Percentiles are `percentile_disc` over per-session totals (legs attributed to their
parent). A percentile that includes the candidate can never be exceeded by it while
fewer than 100 sessions exist, so when the candidate **is** the costliest session the
leave-one-out percentiles (the distribution of the _other_ sessions) are used. With no
other session at all both bars collapse to `RUNAWAY_MIN_COST_USD` (default `$5`) —
the cold-start floor; raise it on a fresh deployment if that is too eager.

"Scope-wide" means the whole deployment (single-tenant); the stats query is the same
`sessionCostStats` the console could scope per workspace.

### Actions

| `RUNAWAY_ACTION` | Effect                                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flag` (default) | audit row `session.runaway` (`action: flagged`) + alert `session.runaway` (severity `warning`)                                                           |
| `block`          | the above with `action: blocked` / severity `critical`, **plus** a `session_block` row (`source: runaway`, TTL `RUNAWAY_BLOCK_TTL_MINUTES`, default 240) |

A session is never re-alerted within the block TTL (in-process dedupe; an
already-blocked session — by a previous tick, another replica or an operator — is
skipped outright). The alert event matches `@gulley/alerts`' `SessionRunawayAlert`
(`session`, `workspaceId`, `principalId?`, `costMicroUsd`, `baselineMicroUsd`,
`orgP99MicroUsd`, `action`, `at`, `severity`).

### Tuning

| Knob                                | Default | Notes                                                  |
| ----------------------------------- | ------- | ------------------------------------------------------ |
| `RUNAWAY_DETECTOR_INTERVAL_SECONDS` | `300`   | `0` disables the job                                   |
| `RUNAWAY_WINDOW_MINUTES`            | `60`    | how recently a session must have spent to be scored    |
| `RUNAWAY_BASELINE_DAYS`             | `7`     | the baseline distribution window (and the span of `C`) |
| `RUNAWAY_MIN_COST_USD`              | `5`     | absolute floor; the only bar when no baseline exists   |
| `RUNAWAY_ACTION`                    | `flag`  | `block` turns the kill switch on                       |
| `RUNAWAY_BLOCK_TTL_MINUTES`         | `240`   | block lifetime and re-alert suppression                |

Start in `flag`, watch the `session.runaway` audit rows / alerts for a week, then
switch to `block`. Per-session budget caps (`BUDGET_ATTR_CAPS` keyed on `session`)
remain the hard, deterministic limit; the detector catches the sessions that stay
under a cap but far outside the norm.

## 4. Session kill switch

A `session_block` row `(workspace_id, session)` with an optional `expires_at` blocks
that session in that workspace. Rows come from the detector (`source = runaway`) or
an operator (`source = manual`).

- `GET /admin/sessions/blocked?workspaceId&includeExpired` — active blocks in the
  caller's scope.
- `POST /admin/sessions/:session/block` `{ workspaceId, reason, ttlSeconds? }` —
  needs `key:disable` at the workspace; audited `session.blocked`.
- `DELETE /admin/sessions/:session/block?workspaceId=` — same permission; audited
  `session.unblocked`.

The gateway holds a `SessionBlockSnapshot` (refreshed every 10 s on an unref'd
timer; the first load is awaited at boot; a failed refresh keeps the last snapshot)
and, right after authentication and attribution, refuses a blocked session before any
budget or upstream work:

```http
HTTP/1.1 403 Forbidden
{ "type": "error", "error": { "type": "session_blocked", "message": "this session is blocked by policy" } }
```

audited as `policy.session_blocked`. A block takes effect within one refresh
interval on every replica and lifts on its own at `expires_at` (honoured locally
between refreshes) or on unblock. Expired rows are reclaimed by
`PostgresSessionBlockStore.sweepExpired`.

Console: **FinOps → Runaway sessions** lists blocks with reason, source and expiry,
unblocks, and places a manual block.
