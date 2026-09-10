# --- identity / region -----------------------------------------------------

variable "name" {
  description = "Name prefix for every resource (also the EKS cluster name). Keep it DNS/label safe."
  type        = string
  default     = "gulley-eks-test"
}

variable "aws_region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "tier" {
  description = "Cost/HA preset. 'test' = cheapest working footprint (2 AZ, 1 NAT, single-AZ data, 1 shared Redis, 2 small Spot nodes). 'prod' = multi-AZ HA. Every knob below can still override the preset."
  type        = string
  default     = "test"

  validation {
    condition     = contains(["test", "prod"], var.tier)
    error_message = "tier must be \"test\" or \"prod\"."
  }
}

variable "tags" {
  description = "Extra tags merged onto every resource (on top of the provider default_tags)."
  type        = map(string)
  default     = {}
}

# --- networking ------------------------------------------------------------

variable "cidr" {
  description = "VPC CIDR (/16 gives room for the /20 subnets carved per AZ)."
  type        = string
  default     = "10.44.0.0/16"
}

# --- kubernetes ------------------------------------------------------------

variable "kubernetes_version" {
  description = "EKS control-plane Kubernetes version. Pick a currently-supported minor (aws eks describe-addon-versions)."
  type        = string
  default     = "1.30"
}

variable "endpoint_public_access" {
  description = "Expose the EKS API server publicly (so kubectl/helm reach it without a bastion). Private access is always on. Restrict with endpoint_public_access_cidrs."
  type        = bool
  default     = true
}

variable "endpoint_public_access_cidrs" {
  description = "CIDRs allowed to reach the public API endpoint. Default open; TIGHTEN for prod."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "node_ami_type" {
  description = "Managed node group AMI type. AL2023_ARM_64_STANDARD (Graviton; cheaper) or AL2023_x86_64_STANDARD. Must match the chart image's platform."
  type        = string
  default     = "AL2023_ARM_64_STANDARD"
}

variable "aurora_engine_version" {
  description = "Aurora PostgreSQL engine version (Serverless v2). Pick a currently-available minor."
  type        = string
  default     = "16.8"
}

# --- chart install (second-apply) ------------------------------------------

variable "install_chart" {
  description = "false (default) => provision infra only; run `terraform apply` a SECOND time with true to install the Helm chart once the cluster + data layer exist (the kube/helm providers can only reach the API server after the cluster is up). true => also install deploy/helm/gulley."
  type        = bool
  default     = false
}

variable "chart_path" {
  description = "Path to the Gulley Helm chart, relative to this module."
  type        = string
  default     = "../../deploy/helm/gulley"
}

variable "image_repository" {
  description = "Container image repository for the chart (gateway + control-api)."
  type        = string
  default     = "ghcr.io/bogware/gulley"
}

variable "image_tag" {
  description = "Container image tag for the chart."
  type        = string
  default     = "latest"
}

variable "existing_secret_name" {
  description = "Name of a Kubernetes Secret (in the release namespace) holding the provider keys + GULLEY_KEY_PEPPER (keys must equal config.ts env names). Created out-of-band before the chart-install apply. Empty => none (dev)."
  type        = string
  default     = ""
}

variable "namespace" {
  description = "Kubernetes namespace to install the chart into."
  type        = string
  default     = "gulley"
}

# ---------------------------------------------------------------------------
# Preset OVERRIDES. Each defaults to null => take the value from the `tier`
# preset in locals.tf.
# ---------------------------------------------------------------------------

variable "az_count" {
  description = "AZs to span (>=2; Aurora/ElastiCache subnet groups need two)."
  type        = number
  default     = null
}

variable "single_nat" {
  description = "true => one shared NAT gateway; false => one per AZ (HA, costlier)."
  type        = bool
  default     = null
}

variable "multi_az" {
  description = "true => Aurora 2 instances + each Redis group 2 nodes + automatic failover."
  type        = bool
  default     = null
}

variable "min_acu" {
  description = "Aurora Serverless v2 minimum ACU."
  type        = number
  default     = null
}

variable "max_acu" {
  description = "Aurora Serverless v2 maximum ACU."
  type        = number
  default     = null
}

variable "redis_node_type" {
  description = "ElastiCache node type for every Redis replication group."
  type        = string
  default     = null
}

variable "redis_single_node" {
  description = "true => ONE Redis group shared by all three roles (cheapest, test). false => three role-split groups (prod)."
  type        = bool
  default     = null
}

variable "node_instance_types" {
  description = "Managed node group instance types."
  type        = list(string)
  default     = null
}

variable "node_capacity_type" {
  description = "ON_DEMAND or SPOT for the node group."
  type        = string
  default     = null
}

variable "node_desired_size" {
  description = "Managed node group desired size."
  type        = number
  default     = null
}

variable "node_min_size" {
  description = "Managed node group min size."
  type        = number
  default     = null
}

variable "node_max_size" {
  description = "Managed node group max size."
  type        = number
  default     = null
}

variable "deletion_protection" {
  description = "true => Aurora deletion protection + final snapshot (blocks destroy). false => clean teardown."
  type        = bool
  default     = null
}

variable "log_retention_days" {
  description = "CloudWatch log-group retention (days) for the EKS control-plane logs."
  type        = number
  default     = null
}
