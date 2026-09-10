# KMS keys, Aurora PostgreSQL Serverless v2, and the role-split ElastiCache Redis trio.

# --- KMS -------------------------------------------------------------------
resource "aws_kms_key" "this" {
  for_each                = toset(["database", "cache", "eks"])
  description             = "${var.name} ${each.key}"
  enable_key_rotation     = true
  deletion_window_in_days = 7
  tags                    = merge(var.tags, { Purpose = each.key })
}

resource "aws_kms_alias" "this" {
  for_each      = aws_kms_key.this
  name          = "alias/${var.name}-${each.key}"
  target_key_id = each.value.id
}

# --- Aurora PostgreSQL Serverless v2 ---------------------------------------
resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-aurora"
  subnet_ids = aws_subnet.private[*].id
  tags       = var.tags
}

resource "aws_rds_cluster" "this" {
  cluster_identifier          = "${var.name}-aurora"
  engine                      = "aurora-postgresql"
  engine_mode                 = "provisioned"
  engine_version              = var.aurora_engine_version
  database_name               = "gulley"
  master_username             = "gulley"
  manage_master_user_password = true # RDS-managed secret; never in TF state
  db_subnet_group_name        = aws_db_subnet_group.this.name
  vpc_security_group_ids      = [aws_security_group.data.id]
  storage_encrypted           = true
  kms_key_id                  = aws_kms_key.this["database"].arn
  deletion_protection         = local.deletion_protection
  skip_final_snapshot         = !local.deletion_protection
  final_snapshot_identifier   = local.deletion_protection ? "${var.name}-aurora-final" : null

  serverlessv2_scaling_configuration {
    min_capacity = local.min_acu
    max_capacity = local.max_acu
  }

  tags = var.tags
}

resource "aws_rds_cluster_instance" "this" {
  count                = local.multi_az ? 2 : 1
  identifier           = "${var.name}-aurora-${count.index}"
  cluster_identifier   = aws_rds_cluster.this.id
  instance_class       = "db.serverless"
  engine               = aws_rds_cluster.this.engine
  engine_version       = aws_rds_cluster.this.engine_version
  db_subnet_group_name = aws_db_subnet_group.this.name
  tags                 = var.tags
}

# --- ElastiCache Redis -----------------------------------------------------
resource "aws_elasticache_subnet_group" "this" {
  name       = "${var.name}-redis"
  subnet_ids = aws_subnet.private[*].id
  tags       = var.tags
}

resource "aws_elasticache_parameter_group" "lru" {
  name   = "${var.name}-redis-lru"
  family = "redis7"
  parameter {
    name  = "maxmemory-policy"
    value = "allkeys-lru"
  }
}

resource "aws_elasticache_parameter_group" "noeviction" {
  name   = "${var.name}-redis-noeviction"
  family = "redis7"
  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }
}

# One shared group (test) or three role-split groups (prod) — same eviction-policy
# split the app requires (cache = allkeys-lru, counters + vector = noeviction).
resource "aws_elasticache_replication_group" "this" {
  for_each                   = local.redis_groups
  replication_group_id       = "${var.name}-${each.key}"
  description                = "${var.name} redis (${each.key})"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = local.redis_node_type
  num_cache_clusters         = local.multi_az ? 2 : 1
  automatic_failover_enabled = local.multi_az
  multi_az_enabled           = local.multi_az
  parameter_group_name       = each.value == "lru" ? aws_elasticache_parameter_group.lru.name : aws_elasticache_parameter_group.noeviction.name
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [aws_security_group.data.id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  kms_key_id                 = aws_kms_key.this["cache"].arn
  port                       = 6379
  tags                       = merge(var.tags, { Role = each.key })
}
