# Gulley on EKS — a self-contained Terraform root module, sibling to ../terraform (ECS).
#
# Provisions the cloud-agnostic Helm chart's substrate on AWS: an EKS cluster (IRSA-
# enabled), a Graviton managed node group, Aurora PostgreSQL Serverless v2, the
# role-split ElastiCache Redis trio, KMS, and (optionally, second apply) a helm_release
# of deploy/helm/gulley. A `tier` preset (test/prod) picks a cost/HA profile; every knob
# is overridable — mirroring ../terraform. See README.md for the two-phase apply.

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.31"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.14"
    }
  }

  # backend "s3" {}   # uncomment for a durable/shared deployment (see README.md)
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "gulley"
      Tier      = var.tier
      ManagedBy = "terraform"
      Module    = var.name
      Platform  = "eks"
    }
  }
}

# The kubernetes/helm providers authenticate to the just-created cluster with a short-
# lived token minted by the AWS CLI (`aws eks get-token`) — no kubeconfig on disk, no
# long-lived secret in state. Only exercised when install_chart = true.
provider "kubernetes" {
  host                   = aws_eks_cluster.this.endpoint
  cluster_ca_certificate = base64decode(aws_eks_cluster.this.certificate_authority[0].data)
  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", aws_eks_cluster.this.name, "--region", var.aws_region]
  }
}

provider "helm" {
  kubernetes {
    host                   = aws_eks_cluster.this.endpoint
    cluster_ca_certificate = base64decode(aws_eks_cluster.this.certificate_authority[0].data)
    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", aws_eks_cluster.this.name, "--region", var.aws_region]
    }
  }
}
