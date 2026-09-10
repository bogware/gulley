data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  # ---- tier presets -------------------------------------------------------
  presets = {
    test = {
      az_count            = 2
      single_nat          = true
      multi_az            = false
      min_acu             = 0.5
      max_acu             = 2
      redis_node_type     = "cache.t4g.micro"
      redis_single_node   = true
      node_instance_types = ["t4g.medium"]
      node_capacity_type  = "SPOT"
      node_desired_size   = 2
      node_min_size       = 2
      node_max_size       = 4
      deletion_protection = false
      log_retention_days  = 7
    }
    prod = {
      az_count            = 3
      single_nat          = false
      multi_az            = true
      min_acu             = 1
      max_acu             = 16
      redis_node_type     = "cache.r7g.large"
      redis_single_node   = false
      node_instance_types = ["m7g.large"]
      node_capacity_type  = "ON_DEMAND"
      node_desired_size   = 3
      node_min_size       = 3
      node_max_size       = 10
      deletion_protection = true
      log_retention_days  = 30
    }
  }
  p = local.presets[var.tier]

  # ---- effective values (explicit var overrides the preset) ---------------
  az_count            = coalesce(var.az_count, local.p.az_count)
  single_nat          = var.single_nat != null ? var.single_nat : local.p.single_nat
  multi_az            = var.multi_az != null ? var.multi_az : local.p.multi_az
  min_acu             = coalesce(var.min_acu, local.p.min_acu)
  max_acu             = coalesce(var.max_acu, local.p.max_acu)
  redis_node_type     = coalesce(var.redis_node_type, local.p.redis_node_type)
  redis_single_node   = var.redis_single_node != null ? var.redis_single_node : local.p.redis_single_node
  node_instance_types = coalesce(var.node_instance_types, local.p.node_instance_types)
  node_capacity_type  = coalesce(var.node_capacity_type, local.p.node_capacity_type)
  node_desired_size   = coalesce(var.node_desired_size, local.p.node_desired_size)
  node_min_size       = coalesce(var.node_min_size, local.p.node_min_size)
  node_max_size       = coalesce(var.node_max_size, local.p.node_max_size)
  deletion_protection = var.deletion_protection != null ? var.deletion_protection : local.p.deletion_protection
  log_retention_days  = coalesce(var.log_retention_days, local.p.log_retention_days)

  # ---- derived ------------------------------------------------------------
  account_id  = data.aws_caller_identity.current.account_id
  region_name = data.aws_region.current.name
  azs         = slice(data.aws_availability_zones.available.names, 0, local.az_count)
  nat_count   = local.single_nat ? 1 : local.az_count

  # Redis: one shared group (all roles -> one endpoint) or three role-split.
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

  # The gateway ServiceAccount that IRSA binds (chart default SA name = fullname =
  # "<release>-<chart>"; the chart's serviceAccount.name can override it).
  gateway_sa_namespace = var.namespace
  gateway_sa_name      = "${var.name}-gateway-sa"
}
