# Gulley — Terraform deploy runbook (for AI agents & operators)

This is the **exact, ordered** procedure to stand up Gulley on AWS from this single
Terraform module, and to tear it down cleanly. It is written to be followed
literally. Commands are POSIX `sh`/`bash` + AWS CLI v2 + Terraform ≥ 1.6.

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
  **Docker with buildx** (the images are `linux/arm64` for Fargate ARM64).
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

## 4. Build & push the two ARM64 images

The API image (gateway + control-api) is one monorepo image; the web image is the
Next.js console. Both build from the repo root.

```sh
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${ECR_API%%/*}"

# from the repo root:
( cd ../.. && docker buildx build --platform linux/arm64 \
    -f apps/gateway/Dockerfile -t "$ECR_API:latest" --push . )

# The console proxies /control/* to the control-api at BUILD time (Next.js bakes the
# rewrite destination), so the api host MUST be passed as a build arg:
( cd ../.. && docker buildx build --platform linux/arm64 \
    --build-arg CONTROL_API_URL="https://$API_DOMAIN" \
    -f apps/web/Dockerfile     -t "$ECR_WEB:latest" --push . )
```

(Host is x86_64? Set `cpu_architecture = "X86_64"` in tfvars and build
`--platform linux/amd64` — native builds are much faster than QEMU cross-builds.)

(`ci/build-image.sh` does the API build with SBOM/provenance + cosign signing for
CI; `SKIP_SIGN=1` for a local build. The plain buildx commands above are fine for a
test.)

## 5. Populate the six secrets

Terraform created them **empty**. Every secret referenced by a task must have a
value or the task fails to start. Compose `DATABASE_URL` from the RDS-managed master
secret + the Aurora endpoint:

```sh
DB_PW=$(aws secretsmanager get-secret-value --secret-id "$MASTER_SECRET" \
        --query SecretString --output text | python -c 'import sys,json;print(json.load(sys.stdin)["password"])')
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

A fresh Aurora has no schema. Run the one-off migrate task (it uses the API image +
the `db-url` secret) inside the VPC:

```sh
NET=$(terraform output -json run_task_network)
SUBNETS=$(echo "$NET" | python -c 'import sys,json;print(",".join(json.load(sys.stdin)["subnets"]))')
SGS=$(echo    "$NET" | python -c 'import sys,json;print(",".join(json.load(sys.stdin)["security_groups"]))')

TASK_ARN=$(aws ecs run-task --cluster "$CLUSTER" \
  --task-definition "$(terraform output -raw migrate_task_definition)" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SGS],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' --output text)

aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"
aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[0].exitCode'   # must be 0
```

If the exit code is not `0`, read the `migrate` log stream in the
`/gulley/<name>` CloudWatch log group.

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

The gateway target is healthy only once `/ready` returns 200, which needs
`DATABASE_URL` + `GULLEY_KEY_PEPPER` + ≥1 provider key (all set in step 5).

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
restart), mint a **virtual key** (Keys page), and send a real LLM request through the
gateway pointing your client's base URL at `$API` (Anthropic Messages:
`POST $API/v1/messages`).

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

## 9. Teardown (clean, complete)

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
- **Redeploys:** push a new image tag and `terraform apply -var image_tag=<tag>`
  (the test-tier ECR is MUTABLE so `:latest` can be re-pushed + a service force-new-
  deployment; the prod-tier ECR is IMMUTABLE — use a unique tag).
- **Gateway metrics in the console:** the gateway exposes Prometheus on a separate
  management port not fronted by the ALB; set `GATEWAY_METRICS_URL` +
  `OUTBOUND_HOST_ALLOWLIST` on the control-api to light up the live Observability
  page. Optional subsystems (WORM/SIEM/anchor/OAuth broker) render a graceful
  "not enabled" state until configured.
