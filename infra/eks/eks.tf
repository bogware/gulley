# EKS cluster (KMS-encrypted secrets, control-plane logging), OIDC provider for IRSA,
# a Graviton managed node group, core addons, and the IRSA role the gateway assumes.

# --- cluster IAM role ------------------------------------------------------
data "aws_iam_policy_document" "cluster_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cluster" {
  name               = "${var.name}-cluster"
  assume_role_policy = data.aws_iam_policy_document.cluster_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "cluster" {
  for_each   = toset(["arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"])
  role       = aws_iam_role.cluster.name
  policy_arn = each.value
}

resource "aws_cloudwatch_log_group" "cluster" {
  name              = "/aws/eks/${var.name}/cluster"
  retention_in_days = local.log_retention_days
  tags              = var.tags
}

# --- cluster ---------------------------------------------------------------
resource "aws_eks_cluster" "this" {
  name     = var.name
  role_arn = aws_iam_role.cluster.arn
  version  = var.kubernetes_version

  enabled_cluster_log_types = ["api", "audit", "authenticator"]

  vpc_config {
    subnet_ids              = concat(aws_subnet.private[*].id, aws_subnet.public[*].id)
    endpoint_private_access = true
    endpoint_public_access  = var.endpoint_public_access
    public_access_cidrs     = var.endpoint_public_access_cidrs
  }

  encryption_config {
    provider {
      key_arn = aws_kms_key.this["eks"].arn
    }
    resources = ["secrets"]
  }

  # API+ConfigMap so the node role's aws-auth entry AND IAM principals both work.
  access_config {
    authentication_mode = "API_AND_CONFIG_MAP"
  }

  tags       = var.tags
  depends_on = [aws_iam_role_policy_attachment.cluster, aws_cloudwatch_log_group.cluster]
}

# --- OIDC provider (IRSA) --------------------------------------------------
data "tls_certificate" "oidc" {
  url = aws_eks_cluster.this.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "this" {
  url             = aws_eks_cluster.this.identity[0].oidc[0].issuer
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.oidc.certificates[0].sha1_fingerprint]
  tags            = var.tags
}

# --- node group IAM role ---------------------------------------------------
data "aws_iam_policy_document" "node_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node" {
  name               = "${var.name}-node"
  assume_role_policy = data.aws_iam_policy_document.node_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "node" {
  for_each = toset([
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
    "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
  ])
  role       = aws_iam_role.node.name
  policy_arn = each.value
}

# --- managed node group ----------------------------------------------------
resource "aws_eks_node_group" "this" {
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "${var.name}-ng"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = aws_subnet.private[*].id
  ami_type        = var.node_ami_type
  capacity_type   = local.node_capacity_type
  instance_types  = local.node_instance_types

  scaling_config {
    desired_size = local.node_desired_size
    min_size     = local.node_min_size
    max_size     = local.node_max_size
  }

  update_config {
    max_unavailable = 1
  }

  tags       = var.tags
  depends_on = [aws_iam_role_policy_attachment.node]
}

# --- core addons -----------------------------------------------------------
resource "aws_eks_addon" "this" {
  for_each                    = toset(["vpc-cni", "kube-proxy", "coredns"])
  cluster_name                = aws_eks_cluster.this.name
  addon_name                  = each.value
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"
  # coredns needs nodes to schedule on; the others patch the DaemonSet in place.
  depends_on = [aws_eks_node_group.this]
  tags       = var.tags
}

# --- data-layer ingress from the cluster/node SG ---------------------------
# The managed node group's ENIs use the cluster's primary security group. Let Aurora
# (5432) and Redis (6379) accept traffic from it only.
resource "aws_vpc_security_group_ingress_rule" "data_postgres" {
  security_group_id            = aws_security_group.data.id
  referenced_security_group_id = aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "data_redis" {
  security_group_id            = aws_security_group.data.id
  referenced_security_group_id = aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}

# --- IRSA role for the gateway ServiceAccount ------------------------------
# Bound to a specific namespace/SA via the OIDC subject condition, so only the gateway
# pod can assume it. Grants Bedrock invoke + Secrets Manager read (the SigV4 / provider-
# key access the data plane needs) — no static keys on the node.
data "aws_iam_policy_document" "gateway_irsa_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.this.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${replace(aws_iam_openid_connect_provider.this.url, "https://", "")}:sub"
      values   = ["system:serviceaccount:${local.gateway_sa_namespace}:${local.gateway_sa_name}"]
    }
    condition {
      test     = "StringEquals"
      variable = "${replace(aws_iam_openid_connect_provider.this.url, "https://", "")}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "gateway_irsa" {
  name               = "${var.name}-gateway-irsa"
  assume_role_policy = data.aws_iam_policy_document.gateway_irsa_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "gateway_irsa" {
  statement {
    sid       = "BedrockInvoke"
    actions   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
    resources = ["*"]
  }
  statement {
    sid       = "SecretsRead"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = ["arn:aws:secretsmanager:${local.region_name}:${local.account_id}:secret:gulley/*"]
  }
}

resource "aws_iam_role_policy" "gateway_irsa" {
  name   = "${var.name}-gateway-irsa"
  role   = aws_iam_role.gateway_irsa.id
  policy = data.aws_iam_policy_document.gateway_irsa.json
}
