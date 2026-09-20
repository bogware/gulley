data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  # ---- tier presets -------------------------------------------------------
  presets = {
    test = {
      az_count                   = 2 # floor for Aurora/ElastiCache subnet groups
      single_nat                 = true
      enable_interface_endpoints = false # reach AWS APIs via NAT; save ~14 ENIs
      multi_az                   = false
      min_acu                    = 0.5
      max_acu                    = 2
      redis_node_type            = "cache.t4g.micro"
      redis_single_node          = true
      enable_worm                = false # no COMPLIANCE lock => clean teardown
      worm_mode                  = "GOVERNANCE"
      worm_retention_days        = 1
      cpu                        = 512
      memory                     = 1024
      control_cpu                = 512
      control_memory             = 1024
      web_cpu                    = 512
      web_memory                 = 1024
      desired_count              = 1
      min_capacity               = 1
      max_capacity               = 2
      use_fargate_spot           = true
      deletion_protection        = false
      log_retention_days         = 7
      backup_retention_days      = 1
    }
    prod = {
      az_count                   = 3
      single_nat                 = false
      enable_interface_endpoints = true
      multi_az                   = true
      min_acu                    = 1
      max_acu                    = 16
      redis_node_type            = "cache.r7g.large"
      redis_single_node          = false
      enable_worm                = true
      worm_mode                  = "COMPLIANCE"
      worm_retention_days        = 2555 # 7 years
      cpu                        = 1024
      memory                     = 2048
      control_cpu                = 1024
      control_memory             = 2048
      web_cpu                    = 512
      web_memory                 = 1024
      desired_count              = 3
      min_capacity               = 3
      max_capacity               = 20
      use_fargate_spot           = false
      deletion_protection        = true
      log_retention_days         = 30
      backup_retention_days      = 35
    }
  }
  p = local.presets[var.tier]

  # ---- effective values (explicit var overrides the preset) ---------------
  # coalesce() is null-safe for numbers/strings; booleans use the != null form
  # because coalesce treats `false` as a value to keep (which is what we want)
  # but not as "unset" — so the ternary is clearer and correct for bools.
  az_count                   = coalesce(var.az_count, local.p.az_count)
  single_nat                 = var.single_nat != null ? var.single_nat : local.p.single_nat
  enable_interface_endpoints = var.enable_interface_endpoints != null ? var.enable_interface_endpoints : local.p.enable_interface_endpoints
  multi_az                   = var.multi_az != null ? var.multi_az : local.p.multi_az
  min_acu                    = coalesce(var.min_acu, local.p.min_acu)
  max_acu                    = coalesce(var.max_acu, local.p.max_acu)
  redis_node_type            = coalesce(var.redis_node_type, local.p.redis_node_type)
  redis_single_node          = var.redis_single_node != null ? var.redis_single_node : local.p.redis_single_node
  enable_worm                = var.enable_worm != null ? var.enable_worm : local.p.enable_worm
  worm_mode                  = coalesce(var.worm_mode, local.p.worm_mode)
  worm_retention_days        = coalesce(var.worm_retention_days, local.p.worm_retention_days)
  gw_cpu                     = coalesce(var.cpu, local.p.cpu)
  gw_memory                  = coalesce(var.memory, local.p.memory)
  control_cpu                = coalesce(var.control_cpu, local.p.control_cpu)
  control_memory             = coalesce(var.control_memory, local.p.control_memory)
  web_cpu                    = coalesce(var.web_cpu, local.p.web_cpu)
  web_memory                 = coalesce(var.web_memory, local.p.web_memory)
  desired_count              = coalesce(var.desired_count, local.p.desired_count)
  min_capacity               = coalesce(var.min_capacity, local.p.min_capacity)
  max_capacity               = coalesce(var.max_capacity, local.p.max_capacity)
  use_fargate_spot           = var.use_fargate_spot != null ? var.use_fargate_spot : local.p.use_fargate_spot
  deletion_protection        = var.deletion_protection != null ? var.deletion_protection : local.p.deletion_protection
  log_retention_days         = coalesce(var.log_retention_days, local.p.log_retention_days)
  backup_retention_days      = coalesce(var.backup_retention_days, local.p.backup_retention_days)

  # ---- derived ------------------------------------------------------------
  account_id  = data.aws_caller_identity.current.account_id
  region_name = data.aws_region.current.name
  azs         = slice(data.aws_availability_zones.available.names, 0, local.az_count)
  nat_count   = local.single_nat ? 1 : local.az_count

  # rollout: 0 tasks until enable_services flips true
  gw_desired      = var.enable_services ? local.desired_count : 0
  control_desired = var.enable_services ? 1 : 0
  web_desired     = var.enable_services && var.enable_web ? 1 : 0

  # hostnames
  console_host = var.domain_name
  api_host     = var.api_domain_name != "" ? var.api_domain_name : (var.domain_name != "" ? "api.${var.domain_name}" : "")
  cert_sans    = var.enable_web ? [local.api_host] : []
  base_url     = var.enable_tls ? "https://${local.console_host}" : "http://${aws_lb.this.dns_name}"
  api_base_url = var.enable_tls ? "https://${local.api_host}" : "http://${aws_lb.this.dns_name}"

  ports = {
    gateway = 8080
    control = 8081
    web     = 3000
  }

  # Redis: one shared group (all roles -> same endpoint) or three role-split.
  redis_groups = local.redis_single_node ? {
    shared = "noeviction"
    } : {
    cache    = "lru"
    counters = "noeviction"
    vector   = "noeviction"
  }
  redis_primary = { for k, g in aws_elasticache_replication_group.this : k => g.primary_endpoint_address }
  redis_endpoints = local.redis_single_node ? {
    cache    = local.redis_primary["shared"]
    counters = local.redis_primary["shared"]
    vector   = local.redis_primary["shared"]
  } : local.redis_primary

  # WORM bucket ARN is deterministic so IAM policies never depend on the (optional) bucket resource.
  worm_bucket_name = "${var.name}-audit-worm-${local.account_id}"
  worm_bucket_arn  = "arn:aws:s3:::${local.worm_bucket_name}"

  secret_names = concat([
    "gulley/key-pepper",
    "gulley/admin-session-secret",
    "gulley/db-url",
    "gulley/provider-anthropic",
    "gulley/provider-openai",
    "gulley/provider-bedrock",
    # Ed25519 PEM that signs onboarding packs (populate it like the others; see INSTALL.md).
  ], var.enable_onboarding_packs ? ["gulley/onboarding-signing-key"] : [])
}
