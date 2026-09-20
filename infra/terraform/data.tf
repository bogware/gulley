# Aurora PostgreSQL Serverless v2 (source of truth), role-split ElastiCache Redis,
# and the optional S3 Object Lock WORM audit bucket.

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

  # Point-in-time recovery window (days). The provider default is 1 day — one bad
  # migration discovered on Monday would already be unrecoverable. prod = 35 (the
  # maximum), test = 1. Snapshots inherit tags; Postgres logs go to CloudWatch.
  backup_retention_period         = local.backup_retention_days
  preferred_backup_window         = "03:00-04:00"
  copy_tags_to_snapshot           = true
  enabled_cloudwatch_logs_exports = ["postgresql"]

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

# One shared group (test) or three role-split groups (prod). local.redis_groups
# maps role -> eviction policy; local.redis_endpoints (locals.tf) resolves the
# three role URLs to the right primary endpoint either way.
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

# --- S3 Object Lock audit WORM bucket (optional) ---------------------------

resource "aws_s3_bucket" "worm" {
  count               = local.enable_worm ? 1 : 0
  bucket              = local.worm_bucket_name
  object_lock_enabled = true
  # GOVERNANCE-locked objects can be force-removed with bypass perms on teardown;
  # COMPLIANCE-locked objects cannot be deleted by anyone until retention lapses.
  force_destroy = local.worm_mode == "GOVERNANCE" && !local.deletion_protection
  tags          = merge(var.tags, { Purpose = "audit-worm" })
}

resource "aws_s3_bucket_versioning" "worm" {
  count  = local.enable_worm ? 1 : 0
  bucket = aws_s3_bucket.worm[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "worm" {
  count  = local.enable_worm ? 1 : 0
  bucket = aws_s3_bucket.worm[0].id
  rule {
    default_retention {
      mode = local.worm_mode
      days = local.worm_retention_days
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "worm" {
  count  = local.enable_worm ? 1 : 0
  bucket = aws_s3_bucket.worm[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.this["audit-export"].arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "worm" {
  count                   = local.enable_worm ? 1 : 0
  bucket                  = aws_s3_bucket.worm[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
