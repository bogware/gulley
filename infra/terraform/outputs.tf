output "console_url" {
  description = "Web admin console URL (paste the bootstrap gadm_ token into its sign-in gate)."
  value       = var.enable_web ? local.base_url : null
}

output "api_url" {
  description = "Gateway + control-api base URL. Point LLM clients' base_url here (append /v1); hit control-plane paths (/admin, /orgs, ...) for the admin API."
  value       = local.api_base_url
}

output "alb_dns_name" {
  description = "Raw ALB DNS name (use when enable_tls = false, or for debugging)."
  value       = aws_lb.this.dns_name
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "ecr_api_repository_url" {
  description = "Push the gateway+control-api monorepo image here."
  value       = aws_ecr_repository.this["api"].repository_url
}

output "ecr_web_repository_url" {
  description = "Push the web (Next.js) console image here."
  value       = var.enable_web ? aws_ecr_repository.this["web"].repository_url : null
}

output "aurora_endpoint" {
  description = "Aurora writer endpoint (host for DATABASE_URL)."
  value       = aws_rds_cluster.this.endpoint
}

output "aurora_master_secret_arn" {
  description = "RDS-managed master credential secret (JSON with username/password). Read it to compose the app's DATABASE_URL."
  value       = aws_rds_cluster.this.master_user_secret[0].secret_arn
}

output "redis_endpoints" {
  description = "role -> primary endpoint (all three point at the shared node when redis_single_node)."
  value       = local.redis_endpoints
}

output "worm_bucket" {
  description = "S3 WORM audit bucket (null when enable_worm = false)."
  value       = local.enable_worm ? aws_s3_bucket.worm[0].id : null
}

output "app_secret_arns" {
  description = "name -> Secrets Manager ARN for the six app secrets to populate out-of-band."
  value       = { for k, s in aws_secretsmanager_secret.this : k => s.arn }
}

output "migrate_task_definition" {
  description = "Task definition for the one-off DB migration (aws ecs run-task)."
  value       = aws_ecs_task_definition.migrate.family
}

output "run_task_network" {
  description = "networkConfiguration for `aws ecs run-task` (migrate/one-off tasks) as awsvpc private subnets + service SG."
  value = {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.service.id]
  }
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.this.name
}
