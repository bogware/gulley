# Gulley — Terraform

Infrastructure as code for deploying Gulley to AWS ECS Fargate.

> **Status:** placeholder. The full module set lands in milestone **M6** (see
> [`../../docs/ROADMAP.md`](../../docs/ROADMAP.md)).

## Planned layout

```
infra/terraform/
├─ modules/
│  ├─ network/         VPC, subnets, interface endpoints (bedrock-runtime, secretsmanager, kms, ecr, logs)
│  ├─ data/            Aurora Postgres Serverless v2, ElastiCache Redis (cache / counters / vector)
│  ├─ security/        KMS keys (split by secret class), Secrets Manager, IAM roles, Bedrock assume-role
│  ├─ compute/         ECS cluster, services, ALB (SSE-tuned), autoscaling
│  ├─ edge/            ACM certificates, DNS
│  └─ observability/   log groups, optional OTel collector
└─ envs/
   ├─ dev/             single-AZ, minimal footprint
   └─ prod/            multi-AZ, HA
```

## Key infra constants (from the architecture)

- ALB `idle_timeout.timeout_seconds` ≥ 300 (SSE streams; default 60 is too low).
- Target group `deregistration_delay.timeout_seconds` ~120–300; fast SIGTERM drain.
- Fargate `stopTimeout` max 120s → clients reconnect via `Last-Event-ID` + idempotency.
- Aurora Serverless v2 `serverlessv2_scaling_configuration { min, max }` (0.5-ACU steps).
- Autoscale on active-connection count + event-loop lag, not CPU alone.
