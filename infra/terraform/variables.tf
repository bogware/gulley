# --- identity / region -----------------------------------------------------

variable "name" {
  description = "Name prefix for every resource (also the CloudWatch log-group leaf and ECR repo base). Keep it DNS/label safe."
  type        = string
  default     = "gulley-test"
}

variable "aws_region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "tier" {
  description = "Cost/HA preset. 'test' = cheapest working footprint (1 NAT, single-AZ data, 1 shared Redis, Spot, no WORM). 'prod' = multi-AZ HA. Every knob below can still override the preset."
  type        = string
  default     = "test"

  validation {
    condition     = contains(["test", "prod"], var.tier)
    error_message = "tier must be \"test\" or \"prod\"."
  }
}

variable "tags" {
  description = "Extra tags merged onto every resource (on top of the provider default_tags)."
  type        = map(string)
  default     = {}
}

# --- networking ------------------------------------------------------------

variable "cidr" {
  description = "VPC CIDR. /16 gives room for the /20 public + /20 private subnets this module carves per AZ."
  type        = string
  default     = "10.42.0.0/16"
}

variable "aurora_engine_version" {
  description = "Aurora PostgreSQL engine version (Serverless v2, provisioned engine-mode). AWS retires minor versions over time; pick a currently-available one (aws rds describe-db-engine-versions --engine aurora-postgresql)."
  type        = string
  default     = "16.8"
}

# --- DNS / TLS -------------------------------------------------------------

variable "domain_name" {
  description = "Public hostname for the WEB console (e.g. gulley-test.example.com). Required when enable_tls = true. The API host defaults to api.<domain_name>."
  type        = string
  default     = ""
}

variable "api_domain_name" {
  description = "Public hostname for the gateway + control-api. Empty => api.<domain_name>."
  type        = string
  default     = ""
}

variable "hosted_zone_id" {
  description = "Route53 public hosted-zone id that domain_name lives in. Required when enable_tls = true."
  type        = string
  default     = ""
}

variable "enable_tls" {
  description = "true => ACM DNS-validated cert (SANs: console + api host) on an HTTPS:443 listener with HTTP:80 redirect, plus Route53 alias records. false => HTTP:80 only, no domain/cert needed (throwaway/no-DNS)."
  type        = bool
  default     = true
}

# --- container images ------------------------------------------------------

variable "image_tag" {
  description = "Tag of the API monorepo image (gateway + control-api) in the created ECR repo."
  type        = string
  default     = "latest"
}

variable "web_image_tag" {
  description = "Tag of the web (Next.js console) image in the created <name>-web ECR repo."
  type        = string
  default     = "latest"
}

variable "cpu_architecture" {
  description = "Fargate task CPU architecture. ARM64 (default; cheaper, prod) or X86_64 (handy when building images on an x86 host). Must match the pushed image's platform."
  type        = string
  default     = "ARM64"

  validation {
    condition     = contains(["ARM64", "X86_64"], var.cpu_architecture)
    error_message = "cpu_architecture must be ARM64 or X86_64."
  }
}

# --- rollout control -------------------------------------------------------

variable "enable_services" {
  description = "false => create all infra but run 0 tasks (ECS services desired_count = 0). Lets you push images, populate secrets, and run migrations BEFORE any task boots. Flip to true for the second apply. See INSTALL.md."
  type        = bool
  default     = true
}

# --- optional cross-account Bedrock ---------------------------------------

variable "bootstrap_admin_token_sha256" {
  description = "sha256 hex of the break-glass bootstrap admin token (gadm_...). Non-sensitive (a one-way hash). When set, the control-api enables bootstrap auth and accepts the matching raw token as the admin bearer (console token-gate + admin API). Empty => bootstrap disabled."
  type        = string
  default     = ""
}

variable "bedrock_assume_role_arn" {
  description = "Optional: role to assume for Bedrock in another account. Empty => use local bedrock:* via the task role."
  type        = string
  default     = ""
}

variable "bedrock_external_id" {
  description = "ExternalId required with bedrock_assume_role_arn."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# Preset OVERRIDES. Each defaults to null => take the value from the `tier`
# preset in locals.tf. Set any of them to force a specific value.
# ---------------------------------------------------------------------------

variable "az_count" {
  description = "AZs to span (>=2; Aurora/ElastiCache subnet groups need two)."
  type        = number
  default     = null
}

variable "single_nat" {
  description = "true => one shared NAT gateway; false => one per AZ (HA, costlier)."
  type        = bool
  default     = null
}

variable "enable_interface_endpoints" {
  description = "true => private VPC interface endpoints for ECR/Secrets/KMS/Logs/STS/Bedrock (keeps AWS API traffic off the internet, ~$0.01/hr/ENI/AZ). false => reach AWS APIs via NAT."
  type        = bool
  default     = null
}

variable "multi_az" {
  description = "true => Aurora 2 instances + each Redis group 2 nodes + automatic failover."
  type        = bool
  default     = null
}

variable "min_acu" {
  description = "Aurora Serverless v2 minimum ACU (floor is always billed; never scales to zero)."
  type        = number
  default     = null
}

variable "max_acu" {
  description = "Aurora Serverless v2 maximum ACU."
  type        = number
  default     = null
}

variable "redis_node_type" {
  description = "ElastiCache node type applied to every Redis replication group."
  type        = string
  default     = null
}

variable "redis_single_node" {
  description = "true => ONE Redis replication group shared by all three roles (cache/counters/vector) — cheapest, fine for test. false => three role-split groups (prod; eviction policy per role)."
  type        = bool
  default     = null
}

variable "enable_worm" {
  description = "true => create the S3 Object Lock WORM audit bucket. false (test default) => no WORM bucket, so nothing gets COMPLIANCE-locked and teardown is clean."
  type        = bool
  default     = null
}

variable "worm_mode" {
  description = "S3 Object Lock mode when enable_worm = true. GOVERNANCE (bypassable with permission — safe for tests) or COMPLIANCE (immutable even to root — real prod retention)."
  type        = string
  default     = null

  validation {
    condition     = var.worm_mode == null || contains(["GOVERNANCE", "COMPLIANCE"], coalesce(var.worm_mode, "GOVERNANCE"))
    error_message = "worm_mode must be GOVERNANCE or COMPLIANCE."
  }
}

variable "worm_retention_days" {
  description = "S3 Object Lock default retention (days) when enable_worm = true."
  type        = number
  default     = null
}

variable "cpu" {
  description = "Gateway Fargate task CPU units (256/512/1024/2048/4096)."
  type        = number
  default     = null
}

variable "memory" {
  description = "Gateway Fargate task memory (MiB), valid for the chosen CPU."
  type        = number
  default     = null
}

variable "control_cpu" {
  description = "Control-api Fargate task CPU units."
  type        = number
  default     = null
}

variable "control_memory" {
  description = "Control-api Fargate task memory (MiB)."
  type        = number
  default     = null
}

variable "web_cpu" {
  description = "Web console Fargate task CPU units."
  type        = number
  default     = null
}

variable "web_memory" {
  description = "Web console Fargate task memory (MiB)."
  type        = number
  default     = null
}

variable "enable_web" {
  description = "true => deploy the Next.js admin console as a third ECS service behind the console hostname."
  type        = bool
  default     = true
}

variable "desired_count" {
  description = "Steady-state gateway task count (also the control-api/web baseline is 1 when enabled)."
  type        = number
  default     = null
}

variable "min_capacity" {
  description = "Gateway autoscaling floor."
  type        = number
  default     = null
}

variable "max_capacity" {
  description = "Gateway autoscaling ceiling."
  type        = number
  default     = null
}

variable "use_fargate_spot" {
  description = "true => run tasks on FARGATE_SPOT (cheapest; can be reclaimed). false => on-demand FARGATE."
  type        = bool
  default     = null
}

variable "deletion_protection" {
  description = "true => Aurora deletion protection + final snapshot (blocks terraform destroy until toggled). false => clean teardown."
  type        = bool
  default     = null
}

variable "log_retention_days" {
  description = "CloudWatch log-group retention (days)."
  type        = number
  default     = null
}

# --- coding-harness OAuth + operator escape hatches -------------------------

variable "enable_oauth_broker" {
  description = "Mount the gateway-brokered OAuth surface (device + auth-code/PKCE) on the control-api and accept gko_at_ tokens on the gateway. Needs the DB + key pepper (always present here)."
  type        = bool
  default     = true
}

variable "enable_onboarding_packs" {
  description = "Create the gulley/onboarding-signing-key secret (an Ed25519 private key PEM you populate) and wire it as ONBOARDING_SIGNING_KEY so signed onboarding packs are served."
  type        = bool
  default     = false
}

variable "gateway_extra_env" {
  description = "Additional plain (non-secret) environment for the gateway task — any knob documented in .env.example."
  type        = map(string)
  default     = {}
}

variable "control_extra_env" {
  description = "Additional plain (non-secret) environment for the control-api task — any knob documented in .env.example."
  type        = map(string)
  default     = {}
}
