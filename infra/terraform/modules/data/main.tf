data "aws_caller_identity" "current" {}

# --- Aurora PostgreSQL Serverless v2 ---------------------------------------

resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-aurora"
  subnet_ids = var.subnet_ids
  tags       = var.tags
}

resource "aws_rds_cluster" "this" {
  cluster_identifier          = "${var.name}-aurora"
  engine                      = "aurora-postgresql"
  engine_mode                 = "provisioned"
  engine_version              = "16.4"
  database_name               = "gulley"
  master_username             = "gulley"
  manage_master_user_password = true # RDS-managed secret; never in TF state
  db_subnet_group_name        = aws_db_subnet_group.this.name
  vpc_security_group_ids      = [var.data_security_group_id]
  storage_encrypted           = true
  kms_key_id                  = var.kms_database_arn
  deletion_protection         = var.deletion_protection
  skip_final_snapshot         = !var.deletion_protection
  final_snapshot_identifier   = var.deletion_protection ? "${var.name}-aurora-final" : null

  serverlessv2_scaling_configuration {
    min_capacity = var.min_acu
    max_capacity = var.max_acu
  }

  tags = var.tags
}

resource "aws_rds_cluster_instance" "this" {
  count                = var.multi_az ? 2 : 1
  identifier           = "${var.name}-aurora-${count.index}"
  cluster_identifier   = aws_rds_cluster.this.id
  instance_class       = "db.serverless"
  engine               = aws_rds_cluster.this.engine
  engine_version       = aws_rds_cluster.this.engine_version
  db_subnet_group_name = aws_db_subnet_group.this.name
  tags                 = var.tags
}

# --- ElastiCache Redis (role-split; eviction policy per role) ---------------

resource "aws_elasticache_subnet_group" "this" {
  name       = "${var.name}-redis"
  subnet_ids = var.subnet_ids
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

locals {
  # role -> parameter group. cache is LRU; counters + vector must not evict.
  redis_roles = {
    cache    = aws_elasticache_parameter_group.lru.name
    counters = aws_elasticache_parameter_group.noeviction.name
    vector   = aws_elasticache_parameter_group.noeviction.name
  }
}

resource "aws_elasticache_replication_group" "this" {
  for_each                   = local.redis_roles
  replication_group_id       = "${var.name}-${each.key}"
  description                = "${var.name} redis (${each.key})"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.redis_node_type
  num_cache_clusters         = var.multi_az ? 2 : 1
  automatic_failover_enabled = var.multi_az
  multi_az_enabled           = var.multi_az
  parameter_group_name       = each.value
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [var.data_security_group_id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  kms_key_id                 = var.kms_cache_arn
  port                       = 6379
  tags                       = merge(var.tags, { Role = each.key })
}

# --- S3 Object Lock audit WORM bucket --------------------------------------

resource "aws_s3_bucket" "worm" {
  bucket              = "${var.name}-audit-worm-${data.aws_caller_identity.current.account_id}"
  object_lock_enabled = true
  tags                = merge(var.tags, { Purpose = "audit-worm" })
}

resource "aws_s3_bucket_versioning" "worm" {
  bucket = aws_s3_bucket.worm.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "worm" {
  bucket = aws_s3_bucket.worm.id
  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = var.worm_retention_days
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "worm" {
  bucket = aws_s3_bucket.worm.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_audit_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "worm" {
  bucket                  = aws_s3_bucket.worm.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
