output "cluster_name" {
  description = "EKS cluster name."
  value       = aws_eks_cluster.this.name
}

output "cluster_endpoint" {
  description = "EKS API server endpoint."
  value       = aws_eks_cluster.this.endpoint
}

output "kubeconfig_command" {
  description = "Point kubectl/helm at the cluster."
  value       = "aws eks update-kubeconfig --region ${var.aws_region} --name ${aws_eks_cluster.this.name}"
}

output "oidc_provider_arn" {
  description = "IAM OIDC provider ARN (for additional IRSA roles)."
  value       = aws_iam_openid_connect_provider.this.arn
}

output "gateway_irsa_role_arn" {
  description = "IRSA role the gateway ServiceAccount assumes (Bedrock + Secrets Manager). Annotate the SA with eks.amazonaws.com/role-arn = this."
  value       = aws_iam_role.gateway_irsa.arn
}

output "gateway_service_account" {
  description = "The namespace/name the IRSA trust is scoped to — the chart's serviceAccount.name must match."
  value       = "${local.gateway_sa_namespace}/${local.gateway_sa_name}"
}

output "aurora_endpoint" {
  description = "Aurora writer endpoint (host). Build DATABASE_URL as postgres://gulley:<managed-password>@<host>:5432/gulley and put it in the Kubernetes Secret."
  value       = aws_rds_cluster.this.endpoint
}

output "aurora_master_secret_arn" {
  description = "Secrets Manager ARN of the RDS-managed master password (never in TF state)."
  value       = aws_rds_cluster.this.master_user_secret[0].secret_arn
}

output "redis_endpoints" {
  description = "Role -> Redis primary endpoint (use rediss:// — TLS in transit)."
  value       = local.redis_endpoints
}
