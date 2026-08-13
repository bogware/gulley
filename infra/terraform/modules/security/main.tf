data "aws_caller_identity" "current" {}

locals {
  # Split KMS keys per secret class (blast-radius isolation, ARCH §12).
  key_classes = ["secrets", "database", "cache", "audit-export", "oauth"]
  # Deterministic WORM bucket ARN (same construction as the data module), so the
  # IAM policies here don't create a module cycle with `data`.
  worm_bucket_arn = "arn:aws:s3:::${var.name}-audit-worm-${data.aws_caller_identity.current.account_id}"
}

resource "aws_kms_key" "this" {
  for_each                = toset(local.key_classes)
  description             = "${var.name} ${each.value} encryption key"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  tags                    = merge(var.tags, { Name = "${var.name}-${each.value}", Class = each.value })
}

resource "aws_kms_alias" "this" {
  for_each      = toset(local.key_classes)
  name          = "alias/${var.name}-${each.value}"
  target_key_id = aws_kms_key.this[each.value].key_id
}

# Secrets are provisioned empty; values are written out-of-band (never in TF state).
resource "aws_secretsmanager_secret" "this" {
  for_each   = toset(var.secret_names)
  name       = each.value
  kms_key_id = aws_kms_key.this["secrets"].arn
  tags       = merge(var.tags, { Name = each.value })
}

# --- IAM ------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Task execution role — pulls images + injects secrets into the task at start.
resource "aws_iam_role" "execution" {
  name               = "${var.name}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    sid       = "ReadSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [for s in aws_secretsmanager_secret.this : s.arn]
  }
  statement {
    sid       = "DecryptSecrets"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.this["secrets"].arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "${var.name}-execution-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# Gateway task role — runtime: Bedrock invoke/guardrail, WORM writes, decrypt.
resource "aws_iam_role" "gateway_task" {
  name               = "${var.name}-gateway-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "gateway_task" {
  statement {
    sid       = "Bedrock"
    actions   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:ApplyGuardrail"]
    resources = ["*"]
  }
  statement {
    sid       = "WormWrite"
    actions   = ["s3:PutObject"]
    resources = ["${local.worm_bucket_arn}/*"]
  }
  statement {
    sid       = "Decrypt"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.this["database"].arn, aws_kms_key.this["cache"].arn, aws_kms_key.this["audit-export"].arn]
  }
  dynamic "statement" {
    for_each = var.bedrock_assume_role_arn == "" ? [] : [1]
    content {
      sid       = "AssumeBedrock"
      actions   = ["sts:AssumeRole"]
      resources = [var.bedrock_assume_role_arn]
      condition {
        test     = "StringEquals"
        variable = "sts:ExternalId"
        values   = [var.bedrock_external_id]
      }
    }
  }
}

resource "aws_iam_role_policy" "gateway_task" {
  name   = "${var.name}-gateway-task"
  role   = aws_iam_role.gateway_task.id
  policy = data.aws_iam_policy_document.gateway_task.json
}

# Control-plane task role — reads WORM for chain-anchor verification + oauth key.
resource "aws_iam_role" "control_task" {
  name               = "${var.name}-control-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "control_task" {
  statement {
    sid       = "WormRead"
    actions   = ["s3:GetObject", "s3:ListBucket"]
    resources = [local.worm_bucket_arn, "${local.worm_bucket_arn}/*"]
  }
  statement {
    sid       = "OauthDecrypt"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey", "kms:Sign"]
    resources = [aws_kms_key.this["oauth"].arn, aws_kms_key.this["audit-export"].arn]
  }
  statement {
    sid       = "Guardrail"
    actions   = ["bedrock:ApplyGuardrail"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "control_task" {
  name   = "${var.name}-control-task"
  role   = aws_iam_role.control_task.id
  policy = data.aws_iam_policy_document.control_task.json
}
