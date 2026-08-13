variable "name" {
  type = string
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "kms_key_arn" {
  type        = string
  default     = ""
  description = "Optional CMK for log-group encryption."
}

variable "tags" {
  type    = map(string)
  default = {}
}
