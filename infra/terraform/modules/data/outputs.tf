output "aurora_endpoint" {
  value = aws_rds_cluster.this.endpoint
}

output "aurora_reader_endpoint" {
  value = aws_rds_cluster.this.reader_endpoint
}

output "aurora_master_secret_arn" {
  value = aws_rds_cluster.this.master_user_secret[0].secret_arn
}

output "redis_endpoints" {
  value = { for k, v in aws_elasticache_replication_group.this : k => v.primary_endpoint_address }
}

output "worm_bucket_arn" {
  value = aws_s3_bucket.worm.arn
}

output "worm_bucket_id" {
  value = aws_s3_bucket.worm.id
}
