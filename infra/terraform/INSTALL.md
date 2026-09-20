# Gulley — Terraform deploy runbook (for AI agents & operators)

This is the **exact, ordered** procedure to stand up Gulley on AWS from this single
Terraform module, to upgrade it, and to tear it down cleanly. It is written to be
followed literally. Commands are POSIX `sh`/`bash` + AWS CLI v2 + Terraform ≥ 1.6
(+ `python3` for two lines of JSON parsing).

The module is **one flat root module** (every `*.tf` in this directory). A `tier`
variable picks a cost/HA preset (`test` = cheapest working footprint, `prod` =
multi-AZ HA); every knob is individually overridable (see `variables.tf`).

Architecture stood up: VPC (public/private subnets, NAT) → split-KMS + Secrets
Manager + IAM → Aurora PostgreSQL Serverless v2 + ElastiCache Redis → ECS Fargate
(gateway :8080, control-api :8081, web console :3000) behind one ALB → ACM/Route53.
Exposure: `domain_name` → **web console**; `api.<domain_name>` → **gateway +
control-api** (path-routed).

---

## 0. Prerequisites

- **Terraform ≥ 1.6**, **AWS CLI v2** authenticated (`aws sts get-caller-identity`),
  **Docker with buildx** — only if you build the images yourself; mirroring the
  published, signed images (step 4, option A) needs just `docker login`.
- A **Route53 public hosted zone** you control (needed when `enable_tls = true`).
  Get its id: `aws route53 list-hosted-zones`.
- **Provider API keys** for whichever upstreams you will test (Anthropic, OpenAI).
  Bedrock uses the task IAM role, not a key.
- IAM permissions to create VPC/NAT, ECS, ELB, Aurora, ElastiCache, KMS, Secrets
  Manager, IAM roles, ACM, Route53, ECR, CloudWatch.

Set shell variables used throughout (adjust to taste):

```sh
cd infra/terraform
export AWS_REGION=us-east-1
export AWS_PAGER=""                          # don't page CLI output
export NAME=gulley-test                      # must match var.name
export DOMAIN=gulley-test.example.com        # your console hostname
export API_DOMAIN=api.$DOMAIN
export ZONE_ID=Z0123456789ABCDEFGHIJ         # your Route53 zone id
```

## 1. Configure

```sh
cp test.tfvars.example test.tfvars
# Edit test.tfvars: set domain_name, hosted_zone_id, and bootstrap_admin_token_sha256.
```

Generate the **break-glass admin token** and its hash. Keep `ADMIN_TOKEN` secret
(it is the console/admin bearer); put only the hash in `test.tfvars`:

```sh
export ADMIN_TOKEN="gadm_$(openssl rand -hex 24)"
ADMIN_SHA="$(printf %s "$ADMIN_TOKEN" | sha256sum | cut -d' ' -f1)"
echo "bootstrap_admin_token_sha256 = \"$ADMIN_SHA\"   # <- put this line in test.tfvars"
echo "ADMIN_TOKEN (save it!): $ADMIN_TOKEN"
```

## 2. Init (local state)

Local state is the default (simplest for a throwaway test). For a durable/shared
deployment, uncomment `backend "s3" {}` in `versions.tf` and
`terraform init -backend-config=backend.hcl` instead.

```sh
terraform init
```

## 3. Phase-one apply — infra only, **zero tasks**

`enable_services = false` builds everything (VPC, Aurora, Redis, ALB, ECR repos,
empty secrets) but runs no ECS tasks, so images + secrets + schema can be in place
before anything boots (avoids a crash-loop + circuit-breaker rollback on first boot).

```sh
terraform apply -var-file=test.tfvars -var enable_services=false
```

Capture outputs:

```sh
export ECR_API=$(terraform output -raw ecr_api_repository_url)
export ECR_WEB=$(terraform output -raw ecr_web_repository_url)
export CLUSTER=$(terraform output -raw cluster_name)
export DB_HOST=$(terraform output -raw aurora_endpoint)
export MASTER_SECRET=$(terraform output -raw aurora_master_secret_arn)
```

## 4. Put the two images in ECR

The API image (gateway + control-api) is one monorepo image; the web image is the
Next.js console. ECS pulls both from the ECR repositories the module created, at
the tags in `image_tag` / `web_image_tag` (default `latest`). Pick one option.

**Option A — mirror a release (recommended).** Every tagged release publishes
multi-arch (amd64 + arm64), cosign-signed images with SBOM + provenance to GHCR
(`docs/SUPPLY_CHAIN.md` shows how to verify the signature first). Copy the manifest
into ECR without pulling or rebuilding:

```sh
export GULLEY_TAG=v0.4.0                     # the release you are deploying
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${ECR_API%%/*}"

docker buildx imagetools create -t "$ECR_API:$GULLEY_TAG" "ghcr.io/bogware/gulley:$GULLEY_TAG"
docker buildx imagetools create -t "$ECR_WEB:$GULLEY_TAG" "ghcr.io/bogware/gulley-web:$GULLEY_TAG"
```

Then set `image_tag = "v0.4.0"` and `web_image_tag = "v0.4.0"` in `test.tfvars`
(immutable tags are what the prod tier's ECR requires anyway).

**Option B — build from source.** Both images build from the repo root; the
version + sha build args are what `/health` (version) and the `gulley_build_info`
metric (version + sha) report:

```sh
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${ECR_API%%/*}"

( cd ../.. && docker buildx build --platform linux/arm64 \
    --build-arg GULLEY_VERSION="$(git describe --tags --always)" \
    --build-arg GULLEY_BUILD_SHA="$(git rev-parse --short HEAD)" \
    -f apps/gateway/Dockerfile -t "$ECR_API:latest" --push . )

# The console proxies /control/* to the control-api at RUNTIME (CONTROL_API_URL is a
# task env the module sets), so no build arg is needed:
( cd ../.. && docker buildx build --platform linux/arm64 \
    -f apps/web/Dockerfile     -t "$ECR_WEB:latest" --push . )
```

Host is x86_64? Set `cpu_architecture = "X86_64"` in tfvars and build
`--platform linux/amd64` — native builds are much faster than QEMU cross-builds.
`ci/build-image.sh` is the CI build (SBOM/provenance + cosign; `SKIP_SIGN=1`
locally); the plain buildx commands above are fine for a test.

Either way, both images are distroless (node is the entrypoint; no shell, no
package manager). The API image runs `dist/gateway/main.mjs` /
`dist/control-api/main.mjs`, the migrate task runs `dist/control-api/migrate.mjs`,
and the console runs Next's standalone `server.js`. The image tag must match the
task platform (`cpu_architecture`); the mirrored manifests carry both.

## 5. Populate the six secrets

Terraform created them **empty**. Every secret referenced by a task must have a
value or the task fails to start. Compose `DATABASE_URL` from the RDS-managed master
secret + the Aurora endpoint:

```sh
DB_PW=$(aws secretsmanager get-secret-value --secret-id "$MASTER_SECRET" \
        --query SecretString --output text | python3 -c 'import sys,json;print(json.load(sys.stdin)["password"])')
DB_URL="postgres://gulley:${DB_PW}@${DB_HOST}:5432/gulley?sslmode=require"

put() { aws secretsmanager put-secret-value --secret-id "$1" --secret-string "$2" >/dev/null; echo "set $1"; }

put gulley/key-pepper            "$(openssl rand -hex 24)"
put gulley/admin-session-secret  "$(openssl rand -hex 32)"
put gulley/db-url                "$DB_URL"
put gulley/provider-anthropic    "$ANTHROPIC_API_KEY"     # export this first
put gulley/provider-openai       "$OPENAI_API_KEY"        # export this first
put gulley/provider-bedrock      "disabled"               # placeholder; Bedrock uses IAM
```

> Secrets never enter Terraform state. The bootstrap admin hash is the only
> credential-derived value in tfvars, and it is a one-way hash.

## 6. Run database migrations

A fresh Aurora has no schema. Run the one-off migrate task (it uses the API image's
bundled migrations + the `db-url` secret) inside the VPC. Both planes report `/ready`
503 (`migrations never applied` on a fresh database, `database schema is behind this
build` after an upgrade) until it has run — see "Upgrades" below for the order on a
running stack:

```sh
NET=$(terraform output -json run_task_network)
SUBNETS=$(echo "$NET" | python3 -c 'import sys,json;print(",".join(json.load(sys.stdin)["subnets"]))')
SGS=$(echo    "$NET" | python3 -c 'import sys,json;print(",".join(json.load(sys.stdin)["security_groups"]))')

TASK_ARN=$(aws ecs run-task --cluster "$CLUSTER" \
  --task-definition "$(terraform output -raw migrate_task_definition)" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SGS],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' --output text)

aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"
aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[0].exitCode'   # must be 0
```

The task exits `0` when the schema is current (also when nothing was pending), `2`
on a configuration error (no `DATABASE_URL`, no bundled journal) and `1` when a
migration failed. If it is not `0`, read the `migrate` log stream in the
`/gulley/<name>` CloudWatch log group (`terraform output log_group_name`).

### Gateway metrics

The gateway's Prometheus listener (`METRICS_PORT`, 9090) is a management port that
the ALB does not front and the task does not publish. Scrape it inside the VPC
(a Prometheus/ADOT sidecar or a private scrape target), or let the control-api fetch
it for the console by setting `GATEWAY_METRICS_URL=http://<gateway task ip>:9090/metrics`
via `control_extra_env` (service discovery: Cloud Map / an internal NLB).

## 7. Phase-two apply — start the services

```sh
terraform apply -var-file=test.tfvars     # enable_services defaults to true
```

ECS launches one task each for gateway, control-api, and web (Fargate Spot in the
test tier). Wait for the ALB target groups to report healthy:

```sh
for svc in gateway control-api web; do
  aws ecs wait services-stable --cluster "$CLUSTER" --services "$NAME-$svc"
  echo "$svc stable"
done
```

A target is healthy only once its `/ready` returns 200: the gateway needs
`DATABASE_URL` + `GULLEY_KEY_PEPPER` + at least one provider key (all set in
step 5) and a migrated schema (step 6); the control-api needs the schema too. Until
then the ALB keeps the task out of service and the reason is in the JSON body of
`/ready` and in the task's log stream.

## 8. Verify

```sh
CONSOLE=$(terraform output -raw console_url)
API=$(terraform output -raw api_url)

curl -fsS "$API/health"                    # gateway liveness -> ok
curl -fsS "$API/ready"                      # gateway readiness -> 200 when routes wired
curl -fsS -H "authorization: Bearer $ADMIN_TOKEN" "$API/admin/status" | head -c 400
curl -fsS -o /dev/null -w '%{http_code}\n' "$CONSOLE"   # web console -> 200
```

Then open `$CONSOLE`, paste `ADMIN_TOKEN` into the sign-in gate. Create an org and a
workspace (Orgs & workspaces — they are written through to Postgres and survive a
restart), mint a **virtual key** (Virtual keys page), and send a real request through
the gateway with it. Any Anthropic SDK works by pointing its base URL at `$API`; with
curl:

```sh
export GULLEY_KEY=gk_...                    # the virtual key you just minted
curl -sS "$API/v1/messages" \
  -H "x-api-key: $GULLEY_KEY" -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":64,"messages":[{"role":"user","content":"ping"}]}'
```

The response carries `x-gulley-request-id` and `x-gulley-target`; the request then
shows up under Request logs and Analytics in the console (OpenAI-compatible clients
use `$API/v1/chat/completions` with `Authorization: Bearer $GULLEY_KEY`).

**Coding-harness OAuth** (on by default: `enable_oauth_broker = true`): register a
client under Identity → OAuth broker, then on a developer machine run
`pnpm gulley login --broker $API --client claude-code`, approve the code at
`$CONSOLE/oauth/device`, and point Claude Code / Codex at the gateway with the config
from Identity → Onboarding (auth = OAuth). Runbook: `docs/HARNESS_OAUTH.md`.

Signed onboarding packs need an Ed25519 key: set `enable_onboarding_packs = true`,
then populate the extra secret in step 5:

```sh
put gulley/onboarding-signing-key "$(openssl genpkey -algorithm ed25519)"
```

## 9. Upgrades

Roll a new release in this order so no task ever serves a schema it does not know:

```sh
# 1. mirror (or build) the new images into ECR at their tag — step 4 — then in
#    test.tfvars set image_tag / web_image_tag to it.
# 2. refresh ONLY the migrate task definition and run it (step 6). A schema that is
#    AHEAD of the running build keeps /ready at 200, so the old tasks stay in service:
terraform apply -var-file=test.tfvars -target=aws_ecs_task_definition.migrate
# ... aws ecs run-task ... (step 6, exit code 0)
# 3. roll the services (rolling deployment; the deployment circuit breaker rolls
#    back automatically if the new tasks never report ready):
terraform apply -var-file=test.tfvars
```

The test tier's ECR is MUTABLE, so a re-pushed `:latest` needs
`aws ecs update-service --force-new-deployment` to be picked up; the prod tier's
ECR is IMMUTABLE — always use a unique tag there.

## 10. Teardown (clean, complete)

The test tier is built to destroy cleanly: no COMPLIANCE Object Lock (WORM off),
Aurora `deletion_protection = false` (final snapshot skipped), ECR `force_delete`,
and Secrets Manager `recovery_window_in_days = 0`.

```sh
terraform destroy -var-file=test.tfvars
```

Verify nothing lingers:

```sh
aws ecs list-clusters        --query "clusterArns[?contains(@,'$NAME')]"
aws rds describe-db-clusters  --query "DBClusters[?DBClusterIdentifier=='$NAME-aurora']"
aws elbv2 describe-load-balancers --query "LoadBalancers[?LoadBalancerName=='$NAME']"
aws ecr describe-repositories --query "repositories[?contains(repositoryName,'$NAME')].repositoryName"
```

All should be empty. KMS keys enter a 7-day pending-deletion window (they stop
billing immediately). If you populated a WORM bucket in GOVERNANCE mode, empty it
(with `s3:BypassGovernanceRetention`) before destroy; a COMPLIANCE bucket cannot be
deleted until retention lapses — never enable it for a throwaway stack.

---

## Notes & knobs

- **Scale up:** raise `desired_count`, `max_capacity`, `min_acu`/`max_acu`,
  `redis_node_type`, `cpu`/`memory`, or switch `tier = "prod"` (and override
  individually as needed). `redis_single_node = false` splits Redis back into the
  three role-partitioned groups.
- **No domain / no TLS:** `enable_tls = false` serves plain HTTP on the ALB DNS name
  (`terraform output alb_dns_name`); no Route53/ACM required. Good for a quick smoke.
- **Redeploys:** see "Upgrades" — migrate first, then roll the services.
- **Gateway metrics in the console:** the gateway exposes Prometheus on a separate
  management port not fronted by the ALB; set `GATEWAY_METRICS_URL` +
  `OUTBOUND_HOST_ALLOWLIST` on the control-api to light up the live Observability
  page. Optional subsystems (WORM/SIEM/anchor/OAuth broker) render a graceful
  "not enabled" state until configured.
