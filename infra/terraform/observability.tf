# CloudWatch log group (CMK-encrypted) and ECR repos for the API + web images.

resource "aws_cloudwatch_log_group" "this" {
  name              = "/gulley/${var.name}"
  retention_in_days = local.log_retention_days
  kms_key_id        = aws_kms_key.this["audit-export"].arn
  tags              = var.tags
}

locals {
  # Immutable tags in prod (a signed tag can't be shadowed); mutable in test so
  # you can re-push :latest while iterating.
  ecr_tag_mutability = var.tier == "prod" ? "IMMUTABLE" : "MUTABLE"
  ecr_repos          = var.enable_web ? { api = var.name, web = "${var.name}-web" } : { api = var.name }
}

resource "aws_ecr_repository" "this" {
  for_each             = local.ecr_repos
  name                 = each.value
  image_tag_mutability = local.ecr_tag_mutability
  force_delete         = true # teardown removes the repo even with images present

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = merge(var.tags, { Image = each.key })
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 20 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 20
      }
      action = { type = "expire" }
    }]
  })
}
