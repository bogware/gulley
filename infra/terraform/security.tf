# Split KMS keys (blast-radius isolation), out-of-band-populated Secrets Manager
# secrets, and least-privilege IAM task roles.

locals {
  key_classes = ["secrets", "database", "cache", "audit-export", "oauth"]
}

resource "aws_kms_key" "this" {
  for_each                = toset(local.key_classes)
  description             = "${var.name} ${each.value} encryption key"
  enable_key_rotation     = true
  deletion_window_in_days = 7
  tags                    = merge(var.tags, { Name = "${var.name}-${each.value}", Class = each.value })
}

resource "aws_kms_alias" "this" {
  for_each      = toset(local.key_classes)
  name          = "alias/${var.name}-${each.value}"
  target_key_id = aws_kms_key.this[each.value].key_id
}

# The audit-export key also encrypts the CloudWatch log group; a CMK-encrypted
# log group requires the Logs service principal to be granted in the KEY policy.
data "aws_iam_policy_document" "audit_key" {
  statement {
    sid       = "RootAdmin"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.account_id}:root"]
    }
  }
  statement {
    sid       = "CloudWatchLogs"
    actions   = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.${local.region_name}.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:${local.region_name}:${local.account_id}:log-group:/gulley/*"]
    }
  }
}

resource "aws_kms_key_policy" "audit_export" {
  key_id = aws_kms_key.this["audit-export"].id
  policy = data.aws_iam_policy_document.audit_key.json
}

# Secrets are provisioned empty; values are written out-of-band (never in TF state).
resource "aws_secretsmanager_secret" "this" {
  for_each   = toset(local.secret_names)
  name       = each.value
  kms_key_id = aws_kms_key.this["secrets"].arn
  # Immediate delete/recreate while iterating on a test stack; a recovery window in
  # prod so a mistaken `terraform destroy` cannot vaporise the pepper/session secrets.
  recovery_window_in_days = local.deletion_protection ? 7 : 0
  tags                    = merge(var.tags, { Name = each.value })
}

# --- IAM -------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Task execution role - pulls images + injects secrets + writes logs.
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

# Gateway task role - runtime: Bedrock invoke/guardrail, WORM writes, decrypt.
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

# Control-plane task role - reads WORM for chain-anchor verification + oauth/audit KMS.
resource "aws_iam_role" "control_task" {
  name               = "${var.name}-control-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "control_task" {
  statement {
    sid       = "WormRead"
    actions   = ["s3:GetObject", "s3:ListBucket", "s3:GetObjectRetention", "s3:GetBucketObjectLockConfiguration"]
    resources = [local.worm_bucket_arn, "${local.worm_bucket_arn}/*"]
  }
  # The control plane is the WORM SHIPPER (it mirrors signed audit batches into the
  # Object Lock bucket); it needs to write objects with their retention.
  statement {
    sid       = "WormShip"
    actions   = ["s3:PutObject", "s3:PutObjectRetention"]
    resources = ["${local.worm_bucket_arn}/*"]
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
