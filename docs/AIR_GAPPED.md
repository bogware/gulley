# Air-gapped deployment kit

Gulley runs fully offline — no outbound internet — for sovereign, classified, or otherwise
network-isolated environments. This is the runbook for a no-egress deployment.

## What air-gapped mode does

Set `AIR_GAPPED=true` on **both** the gateway and the control-api. It flips the egress guard
(`@gulley/egress`) to **fail-closed**: any guarded outbound HTTP call without an explicit
allowlist is denied, so the process cannot accidentally reach the public internet. Nothing
is allow-listed implicitly.

Two ways an outbound call stays reachable under air-gap:

- **control-api**: it targets a host on `OUTBOUND_HOST_ALLOWLIST` (WORM/SIEM/anchor/
  shadow-spend/eval-runner/OIDC/Entra and provider base URLs registered through the
  console). This knob exists only on the control-api.
- **gateway**: it uses a feature's `*_ALLOW_INTERNAL` bypass
  (`GUARDRAILS_WEBHOOK_ALLOW_INTERNAL`, `EXTERNAL_AUTHZ_ALLOW_INTERNAL`,
  `REQUEST_MIRROR_ALLOW_INTERNAL`) pointed at an internal host. The gateway has **no**
  `OUTBOUND_HOST_ALLOWLIST`, and the **provider upstream URLs
  (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `EMBEDDINGS_BASE_URL`, `CUSTOM_PROVIDERS`)
  are deliberately not egress-guarded** — they are the product's purpose — so a public
  provider endpoint left in place fails at the first request, not at boot.

Run `gulley doctor` (gateway preflight): `pnpm --filter @gulley/gateway doctor` in the
workspace, or from the image `docker run --rm --env-file <gateway env> gulley:<ver>
dist/gateway/doctor.mjs`. It prints an `air-gapped` finding for every feature that would
try to reach a public host, **including a provider still pointed at its public endpoint
(an error — exit 1)**, so a misconfiguration fails at preflight, not at runtime.

> **Caveat — SDK egress.** The fetch-based egress guard does **not** cover AWS SDK traffic
> (S3 Object Lock for WORM, KMS for envelope/signing). In an air-gapped VPC these must reach
> AWS through **VPC endpoints** (PrivateLink) or an S3/KMS-compatible internal service. If you
> have no AWS at all, leave WORM off (`WORM_ENABLED=false`, the default) and sign attestations
> with the shared-secret `AUDIT_ATTESTATION_KEY` instead of a KMS CMK (see §5).

## 1. Bring the images in

One distroless image runs both planes (`apps/gateway/Dockerfile`; the container command
selects the entry: `dist/gateway/main.mjs` or `dist/control-api/main.mjs`) plus the console
image (`apps/web/Dockerfile`). On a connected build host:

```bash
docker build -t gulley:<ver> -f apps/gateway/Dockerfile \
  --build-arg GULLEY_VERSION=<ver> --build-arg GULLEY_BUILD_SHA=$(git rev-parse --short HEAD) .
docker build -t gulley-web:<ver> -f apps/web/Dockerfile .
docker save gulley:<ver> gulley-web:<ver> | gzip > gulley-images.tar.gz
```

(Or pull the signed release images `ghcr.io/bogware/gulley:<ver>` and
`ghcr.io/bogware/gulley-web:<ver>`, verify them per `docs/SUPPLY_CHAIN.md`, and `docker save`
those.)

The image carries its own migrations (`GULLEY_MIGRATIONS_DIR=/app/dist/migrations`): run
`docker run --rm -e DATABASE_URL=… gulley:<ver> dist/control-api/migrate.mjs` once per
release inside the enclave (exit 0 = schema current, 2 = config error, 1 = failure). Both
planes answer `/ready` 503 until the schema matches their build.

Transfer `gulley-images.tar.gz` across the air-gap (approved media), then on the target:

```bash
gunzip -c gulley-images.tar.gz | docker load
```

Postgres (`pgvector/pgvector:pg16` — the semantic cache needs the `vector` extension) and
the three role-split Redis instances (`redis:7-alpine`; eviction policies as in
`deploy/docker-compose.prod.yml`) run from their own offline images the same way.

## 2. Pin the cost catalog

`models.dev` is unreachable offline, so pin the catalog file and point both apps at it:

```bash
MODELS_CATALOG_FILE=/etc/gulley/models.catalog.json
```

Generate it on a connected host (`pnpm --filter @gulley/gateway catalog:refresh -- --out
./models.catalog.json`) and carry the file across. Without it, pricing falls back to the
in-tree seed table — `gulley doctor` warns.

## 3. Providers must be internal

Point every provider at an internal endpoint reachable inside the enclave: a Bedrock VPC
endpoint, an internal OpenAI-compatible gateway, or an on-prem model server (`CUSTOM_PROVIDERS`,
e.g. vLLM/Ollama). Provider hosts the **control-api** reaches (providers registered through the
console) go on its `OUTBOUND_HOST_ALLOWLIST`; the gateway's provider URLs are not guarded,
which is why `gulley doctor` errors on a public one. There is no public-provider path in
air-gapped mode.

## 4. Guardrails: native + internal only

The native detectors (`GUARDRAILS_ENABLED`) run in-process — no egress. The managed plugins
(OpenAI moderation, Azure Content Safety, Google Model Armor) call public cloud APIs and are
**unavailable** air-gapped. For DLP beyond the native detectors, run an internal DLP service and
wire it via `GUARDRAILS_WEBHOOK_URL` + `GUARDRAILS_WEBHOOK_ALLOW_INTERNAL=true`.

## 5. Audit stays independently verifiable — offline

Air-gap does not weaken the tamper-evident audit trail. Everything an external auditor needs
verifies with **no network and no AWS**:

- `GET /audit/evidence-bundle` (control-api; needs the `audit:verify` permission and a
  configured signer, else 501) exports a self-contained bundle: the signed attestation, the
  full hash-chained rows, and — with an asymmetric signer — a public-key hint.
- Verify it offline with `verifyEvidenceBundle(bundle, { publicKeyPem })` against an
  **out-of-band** copy of the audit public key (`GET /.well-known/gulley-audit-key`, carried
  across separately) — never the key embedded in the bundle.
- With no KMS CMK (`GULLEY_AUDIT_SIGNING_KMS_ARN` unset) the attestation is HMAC-signed with
  the shared-secret `AUDIT_ATTESTATION_KEY` (≥16 chars); the auditor holds the same key and
  verifies with `verifyEvidenceBundle(bundle, { hmacKey })` (`/.well-known/gulley-audit-key`
  returns 404 — there is no public key). `WORM_SIGNING_KEY` is the matching shared-secret
  fallback for the WORM batch signatures and only matters when `WORM_ENABLED=true`.
- Inside the enclave, `AUDIT_ATTESTATION_KEY=… DATABASE_URL=… node
dist/control-api/audit-verify.mjs` re-walks the chain and emits the same signed attestation
  (exit 1 on a break).

## Minimal air-gapped env

```bash
# both apps
AIR_GAPPED=true
MODELS_CATALOG_FILE=/etc/gulley/models.catalog.json

# gateway — an internal OpenAI-compatible model server, native guardrails only
# (baseUrl is the server root: the gateway appends /v1/chat/completions)
CUSTOM_PROVIDERS=[{"provider":"local","baseUrl":"https://models.acme.internal","models":["llama-3.1-70b"]}]
GUARDRAILS_ENABLED=true

# control-api — every control-plane outbound host, and audit signing without KMS
OUTBOUND_HOST_ALLOWLIST=models.acme.internal,siem.acme.internal,gulley-gw.acme.internal
AUDIT_ATTESTATION_KEY=<shared secret, >=16 chars, also held by the auditor>
WORM_ENABLED=false
```

Then run `gulley doctor` and resolve every `air-gapped` finding (it exits 1 on an error)
before going live.
