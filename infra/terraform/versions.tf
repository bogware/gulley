# Gulley — single adaptable Terraform module (see INSTALL.md).
#
# One root module (all *.tf files here compose into it — there are no sub-modules).
# A `tier` preset selects a cost/HA profile ("test" = cheapest working footprint,
# "prod" = multi-AZ HA); every individual knob is still overridable. See variables.tf.

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State backend. Local by default (simplest for a throwaway test tier); for a
  # durable/shared deployment, uncomment and `terraform init -backend-config=backend.hcl`
  # with an S3 bucket + DynamoDB lock table. See INSTALL.md.
  #
  # backend "s3" {}
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "gulley"
      Tier      = var.tier
      ManagedBy = "terraform"
      Module    = var.name
    }
  }
}
