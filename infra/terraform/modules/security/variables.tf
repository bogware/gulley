variable "name" {
  type = string
}

variable "secret_names" {
  type        = list(string)
  default     = ["gulley/key-pepper", "gulley/admin-session-secret", "gulley/db-url", "gulley/provider-anthropic", "gulley/provider-openai", "gulley/provider-bedrock"]
  description = "Secrets Manager secret names to provision (values are set out-of-band)."
}

variable "bedrock_assume_role_arn" {
  type        = string
  default     = ""
  description = "Optional cross-account Bedrock role the task may assume (with ExternalId)."
}

variable "bedrock_external_id" {
  type        = string
  default     = ""
  description = "ExternalId required by the cross-account Bedrock role trust policy."
}

variable "tags" {
  type    = map(string)
  default = {}
}
