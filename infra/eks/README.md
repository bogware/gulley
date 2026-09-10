# Gulley on EKS (Terraform)

A self-contained root module — sibling to [`../terraform`](../terraform) (the ECS
deployment) — that stands up the AWS substrate for the **cloud-agnostic Helm chart**
(`deploy/helm/gulley`): an EKS cluster with IRSA, a Graviton managed node group, Aurora
PostgreSQL Serverless v2, the role-split ElastiCache Redis trio, KMS, and (optionally) a
`helm_release` of the chart.

A `tier` preset picks a cost/HA profile — `test` (2 AZ, 1 NAT, single-AZ data, one shared
Redis, 2 small Spot nodes) or `prod` (multi-AZ HA) — and every knob is overridable
(`variables.tf`), exactly like the ECS module.

## Two-phase apply

The `kubernetes`/`helm` providers can only reach the API server after the cluster exists,
so install is two phases:

```bash
cd infra/eks
cp test.tfvars.example test.tfvars

# Phase 1 — infra only (install_chart defaults to false):
terraform init
terraform apply -var-file=test.tfvars

# Point kubectl/helm at the new cluster:
$(terraform output -raw kubeconfig_command)

# Create the secret the chart projects (keys MUST equal config.ts env names).
# DATABASE_URL is sensitive (it carries the master password from the RDS-managed
# secret whose ARN is in `terraform output aurora_master_secret_arn`) so it lives here,
# never in Terraform/values:
kubectl create namespace gulley
kubectl -n gulley create secret generic gulley-secrets \
  --from-literal=GULLEY_KEY_PEPPER=... \
  --from-literal=ANTHROPIC_UPSTREAM_API_KEY=... \
  --from-literal=DATABASE_URL="postgres://gulley:<pw>@$(terraform output -raw aurora_endpoint):5432/gulley"

# Phase 2 — install the chart:
terraform apply -var-file=test.tfvars -var install_chart=true -var existing_secret_name=gulley-secrets
```

## What IRSA grants

The chart's ServiceAccount is annotated (by the `helm_release`) with the IAM role in
`terraform output gateway_irsa_role_arn`, whose trust is scoped to exactly
`gulley/<name>-gateway-sa`. It grants `bedrock:InvokeModel*` and read of
`secretsmanager:...:secret:gulley/*` — the SigV4 / provider-key access the data plane
needs, with **no static keys on the node**.

## Teardown

```bash
terraform destroy -var-file=test.tfvars   # (add -var install_chart=true if it was installed)
```

`tier = test` sets `deletion_protection = false`, so Aurora tears down cleanly (no final
snapshot). The role-split Redis eviction policies (cache = `allkeys-lru`, counters +
vector = `noeviction`) match what the app requires — identical to the ECS module.
