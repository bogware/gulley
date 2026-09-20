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
- Periodic **manual snapshots** before each release that carries new schema
  migrations (`packages/storage/migrations`, shipped in the image as
  `dist/migrations`) so a bad migration is a one-click rollback.
- The **audit trail is additionally mirrored to S3 with Object Lock** (`worm`
  package) — a copy no operator or attacker can alter or delete for the retention
  period, independent of the database.

## Restore procedure

1. **Provision** a restored Postgres from the target PITR timestamp (or snapshot).
2. **Point the control-plane** at the restored instance in a maintenance window;
   keep the data plane on `/ready` 503 until config is confirmed (it fails closed).
   Both planes also answer `/ready` 503 (`database schema is behind this build`)
   if the snapshot predates the running release — bring the restored schema
   current first with `node dist/control-api/migrate.mjs` from the image (or
   `pnpm --filter @gulley/control-api migrate` in the workspace); exit 0 means
   the schema matches the build.
3. **Verify audit-chain integrity** on the restored data — the hash chain
   (`prevHash → rowHash`, `computeRowHash`) must be continuous, and it must match
   the S3 WORM mirror. A break means the restore is incomplete or tampered:
   - run the attestation CLI against the restored database — it re-walks the
     chain, prints `chain: VERIFIED (n rows)` and emits a signed attestation
     (exit 1 on a break, 2 without the key):

     ```bash
     AUDIT_ATTESTATION_KEY=<shared secret> DATABASE_URL=<restored instance> \
       pnpm --filter @gulley/control-api audit:verify -- --out attestation.json
     # from the image: node dist/control-api/audit-verify.mjs --out attestation.json
     ```

   - then `GET /audit/worm/verify` (control-api; `audit:verify` permission, 501
     when WORM is not configured) to confirm the restored chain matches the
     Object-Lock mirror batch by batch.

4. **Rebuild the counters**: bring up an empty `counters` Redis. Budgets/rate
   limits re-warm from live traffic; historical spend is intact in the ledger, so
   no spend is lost or double-counted.
5. **Confirm config**: run the config **drift report** (`GET /config/drift` on the
   control-api) so the restored config document matches the intended deployment
   before lifting the data plane's readiness gate.
6. **Lift readiness**: once a working context is wired and the schema is current,
   `/ready` returns 200 and the ALB/ECS (or Service) returns the data plane to
   service.

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
