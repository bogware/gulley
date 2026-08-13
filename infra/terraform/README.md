# Gulley — Terraform

Infrastructure as code for deploying Gulley to AWS ECS Fargate.

> **Status:** built in **M6**. `terraform validate` passes for both `envs/dev`
> and `envs/prod`.

## Layout

```
infra/terraform/
├─ modules/
│  ├─ network/         VPC, public/private subnets, NAT, SGs, VPC interface
│  │                   endpoints (ecr.api/ecr.dkr/secretsmanager/kms/logs/sts/
│  │                   bedrock-runtime) + S3 gateway endpoint
│  ├─ security/        split KMS keys (secrets/database/cache/audit-export/oauth),
│  │                   Secrets Manager (empty; values out-of-band), IAM task
│  │                   roles (least-privilege), optional cross-account Bedrock
│  ├─ data/            Aurora PG Serverless v2, Redis×3 (cache=allkeys-lru,
│  │                   counters+vector=noeviction), S3 Object Lock WORM bucket
│  ├─ compute/         ECS cluster, SSE-tuned ALB (idle 300s, dereg delay),
│  │                   task defs (ARM64), services, request-count autoscaling
│  ├─ edge/            ACM certificate (DNS-validated)
│  ├─ observability/   CloudWatch log group, ECR repo (scan-on-push, immutable)
│  └─ stack/           composes the above + the ALB alias record
└─ envs/
   ├─ dev/             single-NAT, single-AZ services, min footprint
   └─ prod/            multi-AZ, HA, deletion protection
```

## Usage

```sh
cd envs/dev            # or envs/prod
cp terraform.tfvars.example terraform.tfvars   # set domain_name + hosted_zone_id
terraform init -backend-config=backend.hcl     # S3 state (bucket/key/region/lock table)
terraform plan
terraform apply
```

After `apply`, set the empty Secrets Manager secrets out-of-band (never in state):
`gulley/key-pepper`, `gulley/admin-session-secret`, `gulley/db-url`,
`gulley/provider-{anthropic,openai,bedrock}`. The container reads them as task
`secrets`. Run DB migrations (`pnpm --filter @gulley/storage db:migrate`) once
Aurora is reachable.

## Validation (no cloud)

```sh
terraform fmt -recursive -check
cd envs/dev  && terraform init -backend=false && terraform validate
cd envs/prod && terraform init -backend=false && terraform validate
```

## Key infra constants (from the architecture)

- ALB `idle_timeout` = 300 (SSE streams; the 60s default kills them).
- Gateway target group `deregistration_delay` = 180 (drain in-flight streams).
- Fargate container `stopTimeout` = 120 → clients reconnect via `Last-Event-ID`.
- Aurora Serverless v2 `serverlessv2_scaling_configuration { min, max }`.
- Redis split by role; counters + vector are `noeviction` (never lose a budget
  counter or silently degrade recall).
- KMS split per secret class; S3 audit bucket is Object Lock COMPLIANCE.
- All AWS API traffic stays on VPC interface endpoints (complements SSRF lockdown).

> **Not applied here:** `terraform apply` needs a real AWS account + state
> backend and is left to the operator; this session validated the configuration
> only (`terraform validate`).
