# Disaster recovery & restore drill

Gulley's durable source of truth is **Postgres**. Everything else is either a
rebuildable projection or a tamper-evident mirror, which shapes both the backup
strategy and the restore order below.

## What holds state

| Store                               | Role                                                                                                                              | On loss                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Postgres**                        | source of truth: virtual keys, spend ledger, request log, hash-chained audit, config document + versions, budgets/rate-limit caps | **must be restored from backup**                                                 |
| **Redis `counters`** (`noeviction`) | live budget/rate-limit counters — a projection of the ledger + windows                                                            | rebuildable; recreate empty and let it re-warm                                   |
| **Redis `cache`** (`allkeys-lru`)   | response cache                                                                                                                    | disposable; cold cache just lowers hit rate                                      |
| **Redis `vector`** (`noeviction`)   | semantic-cache index                                                                                                              | rebuildable from cached rows / re-embedding                                      |
| **S3 WORM mirror** (Object Lock)    | immutable audit copy                                                                                                              | independent tamper-evident record; used to _verify_ a restore, never overwritten |

Because the counters are a projection, a restore does **not** need them — the
gateway rebuilds them. The only hard dependency is Postgres.

## Backups

- **RDS automated backups + PITR** on the Postgres instance (retention ≥ the
  compliance window). Point-in-time recovery is the primary mechanism.
- Periodic **manual snapshots** before each schema migration (`pnpm db:generate`
  changes) so a bad migration is a one-click rollback.
- The **audit trail is additionally mirrored to S3 with Object Lock** (`worm`
  package) — a copy no operator or attacker can alter or delete for the retention
  period, independent of the database.

## Restore procedure

1. **Provision** a restored Postgres from the target PITR timestamp (or snapshot).
2. **Point the control-plane** at the restored instance in a maintenance window;
   keep the data plane on `/ready` 503 until config is confirmed (it fails closed).
3. **Verify audit-chain integrity** on the restored data — the hash chain
   (`prevHash → rowHash`, `computeRowHash`) must be continuous, and it must match
   the S3 WORM mirror. A break means the restore is incomplete or tampered:
   - run `pnpm --filter @gulley/control-api audit:verify` (or, from the image,
     `node dist/control-api/audit-verify.mjs`) against the restored database: it
     re-walks the chain and emits a signed attestation, non-zero on a break;
   - then `GET /audit/worm/verify` (control-api) to confirm the restored chain
     matches the Object-Lock mirror batch by batch.
4. **Rebuild the counters**: bring up an empty `counters` Redis. Budgets/rate
   limits re-warm from live traffic; historical spend is intact in the ledger, so
   no spend is lost or double-counted.
5. **Confirm config**: run the config **drift report** (control-plane) so the
   restored config document matches the intended deployment before lifting the
   data plane's readiness gate.
6. **Lift readiness**: once a working context is wired, `/ready` returns 200 and
   the ALB/ECS returns the data plane to service.

## Drill checklist (run quarterly)

- [ ] Restore the latest PITR into an isolated environment.
- [ ] Audit hash-chain verifies end-to-end and matches the WORM mirror.
- [ ] Row counts (ledger / request log / audit) match expectations for the window.
- [ ] Empty counters Redis re-warms; a test request meters correctly (no double
      charge against the restored ledger).
- [ ] Config drift report is clean.
- [ ] Record the measured **RTO** (time to service) and **RPO** (data loss window
      = PITR granularity) and compare to targets.

## Targets

- **RPO** ≤ 5 min (PITR granularity).
- **RTO** ≤ 1 h (provision + verify + cut over).

These are deployment choices, not code — tune retention/instance class to hit them.
