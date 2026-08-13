output "url" {
  value = module.stack.url
}

output "alb_dns_name" {
  value = module.stack.alb_dns_name
}

output "ecr_repository_url" {
  value = module.stack.ecr_repository_url
}

output "worm_bucket_id" {
  value = module.stack.worm_bucket_id
}
