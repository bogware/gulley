# Deploying Gulley

One container image (`ghcr.io/bogware/gulley`) runs either plane; each deployment picks
the plane by overriding the container `command` with the bundled entry
(`dist/gateway/main.mjs` or `dist/control-api/main.mjs` — the image is distroless: node
is the entrypoint, there is no shell or package manager). The same image carries
`dist/control-api/migrate.mjs` (schema migrations), `dist/gateway/doctor.mjs` (config
preflight) and `dist/control-api/audit-verify.mjs` (audit-chain attestation). Validate
any change to these manifests with `bash ci/helm-check.sh` (the structural checks in
`deploy/validate-manifests.mjs` always run; if `helm` is installed it also lints +
template-renders the chart). CI runs it as the `deploy-manifests` job.

## One command (Docker Compose)

Brings up both planes plus Postgres (`pgvector/pgvector:pg16`) and the role-split Redis
trio (cache = `allkeys-lru`, counters + vector = `noeviction`):

```bash
cp .env.example deploy/.env      # fill provider keys, GULLEY_KEY_PEPPER, POSTGRES_PASSWORD
docker compose -f deploy/docker-compose.prod.yml up -d
curl -s localhost:8080/health    # {"status":"ok","service":"gateway","version":"..."}
curl -s localhost:8080/ready     # 200 once routes are wired and the schema is current
```

`up` runs the one-off `migrate` service first (`dist/control-api/migrate.mjs` applies
the bundled SQL migrations; exit 0 = applied/up-to-date, 2 = config error, 1 = failure)
and both planes wait for it (`service_completed_successfully`), so a fresh database is
schema-current before either serves. Re-running `up` after an image bump re-migrates
idempotently; until the schema matches the build both planes answer `/ready` 503. The
compose file forces `NODE_ENV=production` and requires `GULLEY_KEY_PEPPER` +
`POSTGRES_PASSWORD`, so a copied `.env.example` cannot demote the deployment to a
development posture. Only the gateway's data port (8080) is published on all
interfaces; the control-api (8081) and the metrics listener (9090) bind to loopback —
front them with your own proxy/auth. `stop_grace_period` is 120 s (above the 110 s
`SHUTDOWN_GRACE_MS` default) so in-flight streams drain before SIGKILL, and each plane
runs under a Node heap cap (`--max-old-space-size=768`; override with
`GATEWAY_NODE_OPTIONS` / `CONTROL_API_NODE_OPTIONS`).

Pin `GULLEY_TAG` (and `GULLEY_IMAGE`) in `deploy/.env` for a real deployment; the
default tag is `latest`. `deploy/.env` holds secrets — never commit it.

The admin console is not part of the compose file: run `ghcr.io/bogware/gulley-web`
separately with `CONTROL_API_URL` pointed at the control-api (its `/control/*` proxy
reads that env per request, so the browser only ever talks to the console's origin).

## Kubernetes (Helm)

The chart (`deploy/helm/gulley`, 0.2.x) targets the bundled runtime image and defaults
`image.tag` to its `appVersion` (`v0.4.0`); the tsx-era v0.3.x images do not start
under it.

```bash
# Provider keys, the KMS pepper AND DATABASE_URL (it carries a password) go in ONE
# Secret — never in values.yaml. The chart refuses a credential-bearing URL in
# config.*, which renders into a ConfigMap readable by the whole namespace.
# IMPORTANT: every key here must EXACTLY equal a config.ts env var name — envFrom
# projects the Secret's keys verbatim (unprefixed), so a typo'd key is simply absent
# (e.g. a missing GULLEY_KEY_PEPPER makes the gateway boot health-only / proxy disabled).
kubectl create secret generic gulley-secrets \
  --from-literal=ANTHROPIC_UPSTREAM_API_KEY=... \
  --from-literal=GULLEY_KEY_PEPPER=... \
  --from-literal=DATABASE_URL=postgres://gulley:PASSWORD@host:5432/gulley

helm upgrade --install gulley deploy/helm/gulley \
  --set existingSecret=gulley-secrets \
  --set config.REDIS_CACHE_URL=redis://... \
  --set config.REDIS_COUNTERS_URL=redis://... \
  --set config.REDIS_VECTOR_URL=redis://...
```

Schema migrations run automatically: the chart renders a `pre-install,pre-upgrade`
hook Job (`<release>-migrate`, `migrate.enabled`, on by default) that runs
`dist/control-api/migrate.mjs` from the same image with the same Secret, so every
`helm upgrade --install` migrates **before** the Deployments roll. A failed Job fails
the install/upgrade, keeps its pod for `kubectl logs job/<release>-migrate`, and rolls
nothing; both planes answer `/ready` 503 (`database schema is behind this build`)
until the schema matches the image. With `migrate.enabled=false`, run the same entry
yourself once per release before the upgrade:

```bash
kubectl apply -f - <<'EOF'
apiVersion: batch/v1
kind: Job
metadata:
  name: gulley-migrate
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 600
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: ghcr.io/bogware/gulley:v0.4.0
          args: ['dist/control-api/migrate.mjs'] # the image's ENTRYPOINT is node
          envFrom:
            - secretRef:
                name: gulley-secrets
EOF
kubectl wait --for=condition=complete --timeout=300s job/gulley-migrate
kubectl logs job/gulley-migrate # "migrate: schema is current (applied=...)"
```

The chart renders: a shared ConfigMap (non-secret env), a ServiceAccount (annotate
for IRSA), the gateway Deployment + Service + optional HPA + PodDisruptionBudget, and
the control-api Deployment + Service. Both planes gate on `/ready` (routes wired, DB
schema current; the gateway flips to 503 on SIGTERM so the pod deregisters first);
a node-based `preStop` sleep (the image has no shell) + a `terminationGracePeriodSeconds`
sized above each plane's drain backstop (`SHUTDOWN_GRACE_MS`, derived per plane as
`terminationGracePeriodSeconds − preStopSleepSeconds − drainBufferSeconds`; the render
fails if that is not positive) mean in-flight SSE streams finish before SIGKILL. Probes
use 5 s timeouts and a `/health` startupProbe; a Node heap cap (`nodeOptions` →
`NODE_OPTIONS`) sits under the memory limit; the gateway pods carry
`prometheus.io/scrape` annotations (`gateway.metricsAnnotations`); a mutable `latest`
tag is pulled with `Always`. A soft pod-anti-affinity default spreads replicas across
nodes. Secret VALUES are never in the chart — only the name of a Secret you supply
(secret-ARNs-only ethos carried to Kubernetes).

Opt-in hardening (all default-off / values-gated): `networkPolicy.enabled` for a
default-deny ingress + egress allowlist on both planes (needs a CNI that enforces
NetworkPolicy and the real Postgres/Redis/provider CIDRs); `ingress.enabled` for a
gateway Ingress + TLS; `gateway.autoscaling.customMetrics` to scale on a metric derived
from the gateway's own Prometheus metrics (e.g. a per-pod request rate from
`gulley_requests_total`) via a metrics adapter, with CPU as the fallback.

The **admin web console** (`apps/web`, Next.js) is NOT part of this chart — deploy it
separately (`ghcr.io/bogware/gulley-web`, its own Deployment/Ingress) with
`CONTROL_API_URL` pointed at the control-api Service (`http://<release>-control-api:80`);
the chart deploys the two API planes only.
