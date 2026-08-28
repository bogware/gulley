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
# Provider keys + KMS pepper go in a Secret (never in values.yaml):
kubectl create secret generic gulley-secrets \
  --from-literal=ANTHROPIC_UPSTREAM_API_KEY=... \
  --from-literal=KEY_PEPPER=...

helm install gulley deploy/helm/gulley \
  --set existingSecret=gulley-secrets \
  --set config.DATABASE_URL=postgres://... \
  --set config.REDIS_CACHE_URL=redis://... \
  --set config.REDIS_COUNTERS_URL=redis://... \
  --set config.REDIS_VECTOR_URL=redis://...
```

The chart renders: a shared ConfigMap (non-secret env), a ServiceAccount (annotate
for IRSA), the gateway Deployment + Service + optional HPA, and the control-api
Deployment + Service. `/ready` gates traffic until routes are wired; SIGTERM drives
the bounded graceful drain (`terminationGracePeriodSeconds`). Secret VALUES are
never in the chart — only the name of a Secret you supply (secret-ARNs-only ethos
carried to Kubernetes).
