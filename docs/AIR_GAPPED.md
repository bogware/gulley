# Air-gapped deployment kit

Gulley runs fully offline — no outbound internet — for sovereign, classified, or otherwise
network-isolated environments. This is the runbook for a no-egress deployment.

## What air-gapped mode does

Set `AIR_GAPPED=true` on **both** the gateway and the control-api. It flips the egress guard
(`@gulley/egress`) to **fail-closed**: any guarded outbound HTTP call without an explicit
allowlist is denied, so the process cannot accidentally reach the public internet. Nothing
is allow-listed implicitly.

Two ways an outbound call stays reachable under air-gap:

- It targets a host on `OUTBOUND_HOST_ALLOWLIST` (control-api: WORM/SIEM/anchor/shadow-spend/
  eval-runner and provider base URLs).
- It uses a feature's `*_ALLOW_INTERNAL` bypass (gateway: `GUARDRAILS_WEBHOOK_ALLOW_INTERNAL`,
  `EXTERNAL_AUTHZ_ALLOW_INTERNAL`, `REQUEST_MIRROR_ALLOW_INTERNAL`) pointed at an internal host.

Run `gulley doctor` (gateway) — it prints an `air-gapped` section flagging any feature that
would try to reach a public host, so a misconfiguration fails at preflight, not at runtime.

> **Caveat — SDK egress.** The fetch-based egress guard does **not** cover AWS SDK traffic
> (S3 Object Lock for WORM, KMS for envelope/signing). In an air-gapped VPC these must reach
> AWS through **VPC endpoints** (PrivateLink) or an S3/KMS-compatible internal service. If you
> have no AWS at all, disable WORM (`WORM_ENABLED=false`) and use `WORM_SIGNING_KEY` +
> local-keypair signing instead of a KMS CMK.

## 1. Bring the images in

There is one container image per app (`apps/gateway/Dockerfile`, `apps/control-api/Dockerfile`).
On a connected build host:

```bash
docker build -t gulley-gateway:<ver> -f apps/gateway/Dockerfile .
docker build -t gulley-control-api:<ver> -f apps/control-api/Dockerfile .
docker save gulley-gateway:<ver> gulley-control-api:<ver> | gzip > gulley-images.tar.gz
```

Transfer `gulley-images.tar.gz` across the air-gap (approved media), then on the target:

```bash
gunzip -c gulley-images.tar.gz | docker load
```

Postgres and the three role-split Redis instances (see `docker-compose.yml`) run from their own
offline images the same way.

## 2. Pin the cost catalog

`models.dev` is unreachable offline, so pin the catalog file and point both apps at it:

```bash
MODELS_CATALOG_FILE=/etc/gulley/models.catalog.json
```

Refresh it manually (see `pnpm --filter @gulley/gateway catalog:refresh` on a connected host) and
carry the file across. Without it, pricing falls back to the in-tree seed table — `gulley doctor`
warns.

## 3. Providers must be internal

Point every provider at an internal endpoint reachable inside the enclave: a Bedrock VPC endpoint,
an internal OpenAI-compatible gateway, or an on-prem model server (`CUSTOM_PROVIDERS`, e.g.
vLLM/Ollama). Add each provider host to `OUTBOUND_HOST_ALLOWLIST`. There is no public-provider
path in air-gapped mode.

## 4. Guardrails: native + internal only

The native detectors (`GUARDRAILS_ENABLED`) run in-process — no egress. The managed plugins
(OpenAI moderation, Azure Content Safety, Google Model Armor) call public cloud APIs and are
**unavailable** air-gapped. For DLP beyond the native detectors, run an internal DLP service and
wire it via `GUARDRAILS_WEBHOOK_URL` + `GUARDRAILS_WEBHOOK_ALLOW_INTERNAL=true`.

## 5. Audit stays independently verifiable — offline

Air-gap does not weaken the tamper-evident audit trail. Everything an external auditor needs
verifies with **no network and no AWS**:

- `GET /audit/evidence-bundle` (control-api) exports a self-contained bundle: the signed
  attestation, the full hash-chained rows, and a public-key hint.
- Verify it offline with `verifyEvidenceBundle` against an **out-of-band** copy of the audit
  public key (`GET /.well-known/gulley-audit-key`, carried across separately) — never the key
  embedded in the bundle.
- With a KMS CMK unavailable, sign with a local keypair (`LocalKeypairSigner`) or the shared-secret
  `WORM_SIGNING_KEY`; the auditor verifies with the published public key / shared secret.

## Minimal air-gapped env

```bash
# both apps
AIR_GAPPED=true
OUTBOUND_HOST_ALLOWLIST=models.acme.internal,siem.acme.internal,gulley-gw.acme.internal
MODELS_CATALOG_FILE=/etc/gulley/models.catalog.json

# gateway — an internal OpenAI-compatible model server, native guardrails only
CUSTOM_PROVIDERS=[{"name":"local","baseUrl":"https://models.acme.internal/v1","preset":"openai"}]
GUARDRAILS_ENABLED=true

# control-api — audit signing without KMS
WORM_ENABLED=false
GULLEY_AUDIT_SIGNING_KMS_ARN=      # unset → local-keypair / WORM_SIGNING_KEY signing
```

Then run `gulley doctor` and resolve every `air-gapped` warning before going live.
