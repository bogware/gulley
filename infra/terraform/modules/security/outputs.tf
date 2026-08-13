output "kms_key_arns" {
  value = { for k, v in aws_kms_key.this : k => v.arn }
}

output "secret_arns" {
  value = { for k, v in aws_secretsmanager_secret.this : k => v.arn }
}

output "execution_role_arn" {
  value = aws_iam_role.execution.arn
}

output "gateway_task_role_arn" {
  value = aws_iam_role.gateway_task.arn
}

output "control_task_role_arn" {
  value = aws_iam_role.control_task.arn
}
