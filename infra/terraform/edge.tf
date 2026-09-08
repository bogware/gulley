# TLS + DNS. All conditional on enable_tls: a DNS-validated ACM cert covering the
# console host (+ api host SAN) and Route53 alias records to the ALB. With
# enable_tls = false the ALB serves plain HTTP:80 and none of this is created.

resource "aws_acm_certificate" "this" {
  count                     = var.enable_tls ? 1 : 0
  domain_name               = local.console_host
  subject_alternative_names = local.cert_sans
  validation_method         = "DNS"
  tags                      = var.tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "validation" {
  for_each = var.enable_tls ? {
    for dvo in aws_acm_certificate.this[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  } : {}

  zone_id         = var.hosted_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "this" {
  count                   = var.enable_tls ? 1 : 0
  certificate_arn         = aws_acm_certificate.this[0].arn
  validation_record_fqdns = [for r in aws_route53_record.validation : r.fqdn]
}

# --- Route53 alias records to the ALB --------------------------------------

resource "aws_route53_record" "console" {
  count   = var.enable_tls ? 1 : 0
  zone_id = var.hosted_zone_id
  name    = local.console_host
  type    = "A"
  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "api" {
  count   = var.enable_tls && var.enable_web ? 1 : 0
  zone_id = var.hosted_zone_id
  name    = local.api_host
  type    = "A"
  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}
