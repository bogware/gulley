variable "name" {
  type        = string
  description = "Name prefix for network resources."
}

variable "cidr" {
  type        = string
  default     = "10.0.0.0/16"
  description = "VPC CIDR block."
}

variable "az_count" {
  type        = number
  default     = 2
  description = "Number of AZs to span (dev=1, prod>=2)."
}

variable "single_nat" {
  type        = bool
  default     = false
  description = "Use one shared NAT gateway (dev) instead of one per AZ (prod)."
}

variable "app_port" {
  type        = number
  default     = 8080
  description = "Container port the ALB forwards to."
}

variable "tags" {
  type    = map(string)
  default = {}
}
