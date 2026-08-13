output "log_group_name" {
  value = aws_cloudwatch_log_group.this.name
}

output "ecr_repository_url" {
  value = aws_ecr_repository.this.repository_url
}
