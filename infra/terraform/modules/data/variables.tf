variable "name" {
  type = string
}

variable "subnet_ids" {
  type        = list(string)
  description = "Private subnet ids for Aurora + Redis."
}

variable "data_security_group_id" {
  type = string
}

variable "kms_database_arn" {
  type = string
}

variable "kms_cache_arn" {
  type = string
}

variable "kms_audit_arn" {
  type = string
}

variable "min_acu" {
  type        = number
  default     = 0.5
  description = "Aurora Serverless v2 minimum ACUs."
}

variable "max_acu" {
  type        = number
  default     = 4
  description = "Aurora Serverless v2 maximum ACUs."
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.small"
}

variable "multi_az" {
  type        = bool
  default     = false
  description = "Enable Redis replicas + automatic failover (prod)."
}

variable "worm_retention_days" {
  type        = number
  default     = 2555
  description = "Default S3 Object Lock retention for the audit WORM bucket (COMPLIANCE)."
}

variable "deletion_protection" {
  type    = bool
  default = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
