# Deploying Gulley

One container image runs either plane; each deployment picks the plane by
overriding the container `command`. Validate any change to these manifests with
`bash ci/helm-check.sh` (structural checks always run; if `helm` is installed it
also lints + template-renders the chart).

## One command (Docker Compose)

Brings up both planes plus Postgres and the role-split Redis trio
(cache = `allkeys-lru`, counters + vector = `noeviction`):

```bash
cp .env.example deploy/.env      # fill provider keys + the KMS pepper
docker compose -f deploy/docker-compose.prod.yml up -d
curl -s localhost:8080/health
```

Pin `GULLEY_TAG` (and `GULLEY_IMAGE`) in `deploy/.env` for a real deployment; the
default tag is `latest`. `deploy/.env` holds secrets — never commit it.

## Kubernetes (Helm)

```bash
# Provider keys + KMS pepper go in a Secret (never in values.yaml).
# IMPORTANT: every key here must EXACTLY equal a config.ts env var name — envFrom
# projects the Secret's keys verbatim (unprefixed), so a typo'd key is simply absent
# (e.g. a missing GULLEY_KEY_PEPPER makes the gateway boot health-only / proxy disabled).
kubectl create secret generic gulley-secrets \
  --from-literal=ANTHROPIC_UPSTREAM_API_KEY=... \
  --from-literal=GULLEY_KEY_PEPPER=...

helm install gulley deploy/helm/gulley \
  --set existingSecret=gulley-secrets \
  --set config.DATABASE_URL=postgres://... \
  --set config.REDIS_CACHE_URL=redis://... \
  --set config.REDIS_COUNTERS_URL=redis://... \
  --set config.REDIS_VECTOR_URL=redis://...
```

The chart renders: a shared ConfigMap (non-secret env), a ServiceAccount (annotate
for IRSA), the gateway Deployment + Service + optional HPA + PodDisruptionBudget, and
the control-api Deployment + Service. `/ready` gates traffic until routes are wired
(and flips to 503 immediately on SIGTERM so the pod deregisters first); a `preStop`
sleep + a `terminationGracePeriodSeconds` sized comfortably above the app's drain
backstop (`SHUTDOWN_GRACE_MS`, derived into the ConfigMap) mean in-flight SSE streams
finish before SIGKILL. A soft pod-anti-affinity default spreads replicas across nodes.
Secret VALUES are never in the chart — only the name of a Secret you supply
(secret-ARNs-only ethos carried to Kubernetes).

Opt-in hardening (all default-off / values-gated): `networkPolicy.enabled` for a
default-deny ingress + egress allowlist (needs a CNI that enforces NetworkPolicy and
the real Postgres/Redis/provider CIDRs); `ingress.enabled` for a gateway Ingress + TLS;
`gateway.autoscaling.customMetrics` to scale on the gateway's own Prometheus metrics
(in-flight requests / event-loop lag) via a metrics adapter, with CPU as the fallback.

The **admin web console** (`apps/web`, Next.js) is NOT part of this chart — deploy it
separately (its own image/host) pointed at the control-api Service; the chart deploys
the two API planes only.
