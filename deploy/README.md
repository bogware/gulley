# Deploying Gulley

One container image runs either plane; each deployment picks the plane by
overriding the container `command` with the bundled entry (`dist/gateway/main.mjs`
or `dist/control-api/main.mjs` — the image is distroless: node is the entrypoint,
there is no shell or package manager). Validate any change to these manifests with
`bash ci/helm-check.sh` (structural checks always run; if `helm` is installed it
also lints + template-renders the chart). It runs in CI.

## One command (Docker Compose)

Brings up both planes plus Postgres and the role-split Redis trio
(cache = `allkeys-lru`, counters + vector = `noeviction`):

```bash
cp .env.example deploy/.env      # fill provider keys, GULLEY_KEY_PEPPER, POSTGRES_PASSWORD
docker compose -f deploy/docker-compose.prod.yml up -d
curl -s localhost:8080/health
```

`up` runs the one-off `migrate` service first (bundled SQL migrations; exits 0 when
the schema is current) and both planes wait for it. The compose file forces
`NODE_ENV=production` and requires `GULLEY_KEY_PEPPER` + `POSTGRES_PASSWORD`, so a
copied `.env.example` cannot demote the deployment to a development posture. Only
the gateway's data port is published on all interfaces; the control-api (8081) and
the metrics listener (9090) bind to loopback — front them with your own proxy/auth.

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

# DATABASE_URL carries a password: it belongs in the Secret too (the chart refuses a
# credential-bearing URL in config.*, which renders into a ConfigMap).
kubectl create secret generic gulley-secrets \
  --from-literal=ANTHROPIC_UPSTREAM_API_KEY=... \
  --from-literal=GULLEY_KEY_PEPPER=... \
  --from-literal=DATABASE_URL=postgres://gulley:PASSWORD@host:5432/gulley

helm install gulley deploy/helm/gulley \
  --set existingSecret=gulley-secrets \
  --set config.REDIS_CACHE_URL=redis://... \
  --set config.REDIS_COUNTERS_URL=redis://... \
  --set config.REDIS_VECTOR_URL=redis://...
```

Run the migrations once per release with the same image (a Job or a one-off pod):

```bash
kubectl run gulley-migrate --rm -it --restart=Never \
  --image=ghcr.io/bogware/gulley:v0.4.0 \
  --env-from=secret/gulley-secrets -- dist/control-api/migrate.mjs
```

The chart renders: a shared ConfigMap (non-secret env), a ServiceAccount (annotate
for IRSA), the gateway Deployment + Service + optional HPA + PodDisruptionBudget, and
the control-api Deployment + Service. Both planes gate on `/ready` (routes wired, DB
schema current; the gateway flips to 503 on SIGTERM so the pod deregisters first);
a `preStop` sleep + a `terminationGracePeriodSeconds` sized above each plane's drain
backstop (`SHUTDOWN_GRACE_MS`, derived per plane; the render fails if the budget is
not positive) mean in-flight SSE streams finish before SIGKILL. Probes use 5 s
timeouts and a startupProbe; a Node heap cap (`nodeOptions`) sits under the memory
limit. A soft pod-anti-affinity default spreads replicas across nodes.
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
