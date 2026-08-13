variable "name" {
  type = string
}

variable "aws_region" {
  type = string
}

variable "cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "az_count" {
  type    = number
  default = 2
}

variable "single_nat" {
  type    = bool
  default = false
}

variable "multi_az" {
  type    = bool
  default = true
}

variable "min_acu" {
  type    = number
  default = 0.5
}

variable "max_acu" {
  type    = number
  default = 8
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.small"
}

variable "cpu" {
  type    = number
  default = 1024
}

variable "memory" {
  type    = number
  default = 2048
}

variable "desired_count" {
  type    = number
  default = 2
}

variable "min_capacity" {
  type    = number
  default = 2
}

variable "max_capacity" {
  type    = number
  default = 10
}

variable "image_tag" {
  type    = string
  default = "latest"
}

variable "domain_name" {
  type = string
}

variable "hosted_zone_id" {
  type = string
}

variable "deletion_protection" {
  type    = bool
  default = false
}

variable "bedrock_assume_role_arn" {
  type    = string
  default = ""
}

variable "bedrock_external_id" {
  type    = string
  default = ""
}

variable "tags" {
  type    = map(string)
  default = {}
}
