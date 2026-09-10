# Optional Helm install of deploy/helm/gulley (second-apply: install_chart = true), once
# the cluster + node group + data layer exist. Wires the non-secret Redis endpoints and
# the IRSA annotation onto the gateway ServiceAccount; DATABASE_URL and the provider keys
# stay in the operator-supplied Kubernetes Secret (existing_secret_name) — sensitive
# values never pass through Terraform state (secret-ARNs-only ethos).

resource "helm_release" "gulley" {
  count            = var.install_chart ? 1 : 0
  name             = var.name
  namespace        = var.namespace
  create_namespace = true
  chart            = var.chart_path
  wait             = true
  timeout          = 600

  set {
    name  = "image.repository"
    value = var.image_repository
  }
  set {
    name  = "image.tag"
    value = var.image_tag
  }
  # One ServiceAccount (both planes) annotated for IRSA — the trust in eks.tf is scoped
  # to exactly this namespace/name.
  set {
    name  = "serviceAccount.name"
    value = local.gateway_sa_name
  }
  set {
    name  = "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = aws_iam_role.gateway_irsa.arn
  }
  # TLS-in-transit ElastiCache => rediss:// (not redis://).
  set {
    name  = "config.REDIS_CACHE_URL"
    value = "rediss://${local.redis_endpoints["cache"]}:6379"
  }
  set {
    name  = "config.REDIS_COUNTERS_URL"
    value = "rediss://${local.redis_endpoints["counters"]}:6379"
  }
  set {
    name  = "config.REDIS_VECTOR_URL"
    value = "rediss://${local.redis_endpoints["vector"]}:6379"
  }

  dynamic "set" {
    for_each = var.existing_secret_name != "" ? [1] : []
    content {
      name  = "existingSecret"
      value = var.existing_secret_name
    }
  }

  depends_on = [aws_eks_node_group.this, aws_eks_addon.this]
}
