# Gulley infrastructure (Terraform)

A **single, adaptable Terraform root module** that deploys the whole Gulley stack on
AWS — VPC + NAT, split-KMS + Secrets Manager + IAM, Aurora PostgreSQL Serverless v2 +
ElastiCache Redis, ECS Fargate (gateway + control-api + web console) behind one ALB,
and ACM/Route53. It replaces the older nested `modules/` + `envs/` layout: every
`*.tf` in this directory composes into one module, and environments are just
`.tfvars` files.

## Adaptability

A `tier` variable selects a preset:

| tier   | footprint                                                                                                                                                  |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test` | 1 NAT, single-AZ Aurora (0.5–2 ACU), one shared Redis node, Fargate Spot, no WORM, no interface endpoints — the cheapest working stack.                    |
| `prod` | 3 AZs, NAT per AZ, Aurora multi-AZ, three role-split Redis groups, on-demand Fargate, private interface endpoints, WORM (COMPLIANCE), deletion protection. |

Every knob is individually overridable on top of the preset (see `variables.tf`):
sizing (`min_acu`/`max_acu`, `redis_node_type`, `cpu`/`memory`, `desired_count`,
`min_capacity`/`max_capacity`), toggles (`enable_worm`, `enable_interface_endpoints`,
`redis_single_node`, `enable_tls`, `enable_web`, `use_fargate_spot`,
`enable_services`), and DNS (`domain_name`, `hosted_zone_id`).

## Files

`versions.tf` providers/backend · `variables.tf` inputs · `locals.tf` tier presets +
derived wiring · `network.tf` VPC/subnets/NAT/SGs/endpoints · `security.tf`
KMS/Secrets/IAM · `data.tf` Aurora/Redis/WORM · `observability.tf` logs/ECR ·
`compute.tf` ECS/ALB/services/autoscaling · `edge.tf` ACM/Route53 · `outputs.tf`.

## Deploy

**Follow [INSTALL.md](./INSTALL.md)** — the exact, ordered runbook (two-phase apply,
image mirror/build, secret population, migration, verification, upgrades, teardown).
Quick shape:

```sh
cp test.tfvars.example test.tfvars     # edit domain_name, hosted_zone_id, bootstrap hash
terraform init
terraform apply -var-file=test.tfvars -var enable_services=false   # infra, 0 tasks
# ... mirror the release images into ECR, populate secrets, run the migrate task ...
terraform apply -var-file=test.tfvars                              # start services
# ... test ...
terraform destroy -var-file=test.tfvars                           # clean teardown
```

`bash ci/tf-check.sh` runs `terraform fmt -check` + `validate` (no cloud creds).
