module "network" {
  source     = "../network"
  name       = var.name
  cidr       = var.cidr
  az_count   = var.az_count
  single_nat = var.single_nat
  tags       = var.tags
}

module "security" {
  source                  = "../security"
  name                    = var.name
  bedrock_assume_role_arn = var.bedrock_assume_role_arn
  bedrock_external_id     = var.bedrock_external_id
  tags                    = var.tags
}

module "observability" {
  source      = "../observability"
  name        = var.name
  kms_key_arn = module.security.kms_key_arns["audit-export"]
  tags        = var.tags
}

module "data" {
  source                 = "../data"
  name                   = var.name
  subnet_ids             = module.network.private_subnet_ids
  data_security_group_id = module.network.data_security_group_id
  kms_database_arn       = module.security.kms_key_arns["database"]
  kms_cache_arn          = module.security.kms_key_arns["cache"]
  kms_audit_arn          = module.security.kms_key_arns["audit-export"]
  min_acu                = var.min_acu
  max_acu                = var.max_acu
  redis_node_type        = var.redis_node_type
  multi_az               = var.multi_az
  deletion_protection    = var.deletion_protection
  tags                   = var.tags
}

module "edge" {
  source         = "../edge"
  domain_name    = var.domain_name
  hosted_zone_id = var.hosted_zone_id
  tags           = var.tags
}

module "compute" {
  source                    = "../compute"
  name                      = var.name
  aws_region                = var.aws_region
  vpc_id                    = module.network.vpc_id
  public_subnet_ids         = module.network.public_subnet_ids
  private_subnet_ids        = module.network.private_subnet_ids
  alb_security_group_id     = module.network.alb_security_group_id
  service_security_group_id = module.network.service_security_group_id
  execution_role_arn        = module.security.execution_role_arn
  gateway_task_role_arn     = module.security.gateway_task_role_arn
  control_task_role_arn     = module.security.control_task_role_arn
  image                     = "${module.observability.ecr_repository_url}:${var.image_tag}"
  certificate_arn           = module.edge.certificate_arn
  log_group_name            = module.observability.log_group_name
  desired_count             = var.desired_count
  cpu                       = var.cpu
  memory                    = var.memory
  min_capacity              = var.min_capacity
  max_capacity              = var.max_capacity

  gateway_env = {
    NODE_ENV           = "production"
    GATEWAY_PORT       = "8080"
    BEDROCK_REGION     = var.aws_region
    REDIS_CACHE_URL    = "rediss://${module.data.redis_endpoints["cache"]}:6379"
    REDIS_COUNTERS_URL = "rediss://${module.data.redis_endpoints["counters"]}:6379"
    REDIS_VECTOR_URL   = "rediss://${module.data.redis_endpoints["vector"]}:6379"
  }
  gateway_secrets = {
    GULLEY_KEY_PEPPER          = module.security.secret_arns["gulley/key-pepper"]
    DATABASE_URL               = module.security.secret_arns["gulley/db-url"]
    ANTHROPIC_UPSTREAM_API_KEY = module.security.secret_arns["gulley/provider-anthropic"]
    OPENAI_UPSTREAM_API_KEY    = module.security.secret_arns["gulley/provider-openai"]
    BEDROCK_UPSTREAM_API_KEY   = module.security.secret_arns["gulley/provider-bedrock"]
  }

  control_env = {
    NODE_ENV         = "production"
    CONTROL_API_PORT = "8081"
  }
  control_secrets = {
    GULLEY_KEY_PEPPER           = module.security.secret_arns["gulley/key-pepper"]
    GULLEY_ADMIN_SESSION_SECRET = module.security.secret_arns["gulley/admin-session-secret"]
    DATABASE_URL                = module.security.secret_arns["gulley/db-url"]
  }

  tags = var.tags
}

# ALB alias record lives in the root composition to avoid an edge<->compute cycle.
resource "aws_route53_record" "alb" {
  zone_id = var.hosted_zone_id
  name    = var.domain_name
  type    = "A"
  alias {
    name                   = module.compute.alb_dns_name
    zone_id                = module.compute.alb_zone_id
    evaluate_target_health = true
  }
}
