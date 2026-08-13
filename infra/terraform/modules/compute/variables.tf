variable "name" {
  type = string
}

variable "aws_region" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "alb_security_group_id" {
  type = string
}

variable "service_security_group_id" {
  type = string
}

variable "execution_role_arn" {
  type = string
}

variable "gateway_task_role_arn" {
  type = string
}

variable "control_task_role_arn" {
  type = string
}

variable "image" {
  type        = string
  description = "Container image (ECR repo URL + tag) — the monorepo image runs either app."
}

variable "certificate_arn" {
  type        = string
  description = "ACM certificate ARN for the HTTPS listener."
}

variable "log_group_name" {
  type = string
}

variable "gateway_port" {
  type    = number
  default = 8080
}

variable "control_port" {
  type    = number
  default = 8081
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

variable "gateway_env" {
  type    = map(string)
  default = {}
}

variable "control_env" {
  type    = map(string)
  default = {}
}

variable "gateway_secrets" {
  type        = map(string)
  default     = {}
  description = "Env-var name -> Secrets Manager ARN for the gateway task."
}

variable "control_secrets" {
  type    = map(string)
  default = {}
}

variable "tags" {
  type    = map(string)
  default = {}
}
