output "alb_dns_name" {
  value = module.compute.alb_dns_name
}

output "url" {
  value = "https://${var.domain_name}"
}

output "ecr_repository_url" {
  value = module.observability.ecr_repository_url
}

output "worm_bucket_id" {
  value = module.data.worm_bucket_id
}

output "aurora_endpoint" {
  value = module.data.aurora_endpoint
}

output "kms_key_arns" {
  value = module.security.kms_key_arns
}
