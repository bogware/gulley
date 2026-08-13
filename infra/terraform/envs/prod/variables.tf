variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "image_tag" {
  type    = string
  default = "latest"
}

variable "domain_name" {
  type        = string
  description = "FQDN the ALB serves (e.g. dev.gulley.example.com)."
}

variable "hosted_zone_id" {
  type        = string
  description = "Route53 hosted zone id."
}

variable "bedrock_assume_role_arn" {
  type    = string
  default = ""
}

variable "bedrock_external_id" {
  type    = string
  default = ""
}
