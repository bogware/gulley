terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
  # Remote state: `terraform init -backend-config=backend.hcl`
  # (bucket, key, region, dynamodb_table, encrypt=true).
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Project     = "gulley"
      Environment = "dev"
      ManagedBy   = "terraform"
    }
  }
}

module "stack" {
  source = "../../modules/stack"

  name       = "gulley-dev"
  aws_region = var.aws_region

  az_count        = 2 # Aurora/Redis subnet groups need >=2 AZs even in dev
  single_nat      = true
  multi_az        = false
  min_acu         = 0.5
  max_acu         = 2
  redis_node_type = "cache.t4g.micro"
  cpu             = 512
  memory          = 1024
  desired_count   = 1
  min_capacity    = 1
  max_capacity    = 3

  deletion_protection = false

  image_tag               = var.image_tag
  domain_name             = var.domain_name
  hosted_zone_id          = var.hosted_zone_id
  bedrock_assume_role_arn = var.bedrock_assume_role_arn
  bedrock_external_id     = var.bedrock_external_id

  tags = { Environment = "dev" }
}
