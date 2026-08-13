variable "domain_name" {
  type        = string
  description = "FQDN the ALB serves (e.g. gulley.example.com)."
}

variable "hosted_zone_id" {
  type        = string
  description = "Route53 hosted zone id for DNS validation + records."
}

variable "tags" {
  type    = map(string)
  default = {}
}
