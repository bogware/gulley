terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Project     = "gulley"
      Environment = "prod"
      ManagedBy   = "terraform"
    }
  }
}

module "stack" {
  source = "../../modules/stack"

  name       = "gulley-prod"
  aws_region = var.aws_region

  az_count        = 3
  single_nat      = false
  multi_az        = true
  min_acu         = 1
  max_acu         = 16
  redis_node_type = "cache.r7g.large"
  cpu             = 1024
  memory          = 2048
  desired_count   = 3
  min_capacity    = 3
  max_capacity    = 20

  deletion_protection = true

  image_tag               = var.image_tag
  domain_name             = var.domain_name
  hosted_zone_id          = var.hosted_zone_id
  bedrock_assume_role_arn = var.bedrock_assume_role_arn
  bedrock_external_id     = var.bedrock_external_id

  tags = { Environment = "prod" }
}
