# ECS Fargate cluster, ALB, task definitions and services for the gateway,
# control-api, and web console, plus a one-off migration task.

resource "aws_ecs_cluster" "this" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  tags = var.tags
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
}

# --- ALB -------------------------------------------------------------------

resource "aws_lb" "this" {
  name                       = var.name
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  idle_timeout               = 300 # SSE streams; the 60s default kills them
  drop_invalid_header_fields = true
  enable_http2               = true
  tags                       = var.tags
}

resource "aws_lb_target_group" "gateway" {
  name                 = "${var.name}-gw"
  port                 = local.ports.gateway
  protocol             = "HTTP"
  vpc_id               = aws_vpc.this.id
  target_type          = "ip"
  deregistration_delay = 180 # let in-flight streams drain

  health_check {
    path                = "/ready" # 503 until a working context is wired
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 15
    matcher             = "200"
  }
  tags = var.tags
}

resource "aws_lb_target_group" "control" {
  name                 = "${var.name}-ctl"
  port                 = local.ports.control
  protocol             = "HTTP"
  vpc_id               = aws_vpc.this.id
  target_type          = "ip"
  deregistration_delay = 60

  health_check {
    path    = "/ready"
    matcher = "200"
  }
  tags = var.tags
}

resource "aws_lb_target_group" "web" {
  count                = var.enable_web ? 1 : 0
  name                 = "${var.name}-web"
  port                 = local.ports.web
  protocol             = "HTTP"
  vpc_id               = aws_vpc.this.id
  target_type          = "ip"
  deregistration_delay = 30

  health_check {
    path    = "/"
    matcher = "200-399" # the console root renders the token-gate (200) or redirects
  }
  tags = var.tags
}

# --- listeners -------------------------------------------------------------

locals {
  default_tg_arn   = var.enable_web ? aws_lb_target_group.web[0].arn : aws_lb_target_group.gateway.arn
  use_host_routing = var.enable_tls && var.enable_web

  # Control-plane surfaces route to the control-api by path. An ALB rule allows at
  # most 5 condition VALUES total, and host-routing adds a host_header value, so
  # each group holds <=4 path patterns (4 paths + 1 host = 5).
  control_path_groups = [
    ["/admin/*", "/oauth/*", "/config/*", "/audit/*"],
    ["/memberships*", "/orgs*", "/workspaces*", "/projects*"],
    ["/providers*", "/keys*", "/routes*", "/policies*"],
    ["/budgets*", "/rate-limits*", "/guardrails*", "/model-aliases*"],
    ["/scim/*", "/.well-known/*"],
  ]
  # Gateway's own paths, used only to carve gateway out of a web-default single host.
  # NOT /metrics or /live: the Prometheus listener is a separate management port that
  # the ALB does not front (scrape it inside the VPC / via the control-api's
  # GATEWAY_METRICS_URL), so routing those paths only exposed a 404.
  gateway_paths = ["/v1/*", "/health", "/ready"]
}

# Port 80: redirect to 443 when TLS is on, else it is the primary listener.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  dynamic "default_action" {
    for_each = var.enable_tls ? [1] : []
    content {
      type = "redirect"
      redirect {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }

  dynamic "default_action" {
    for_each = var.enable_tls ? [] : [1]
    content {
      type             = "forward"
      target_group_arn = local.default_tg_arn
    }
  }
}

resource "aws_lb_listener" "https" {
  count             = var.enable_tls ? 1 : 0
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.this[0].certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = local.default_tg_arn
  }
}

locals {
  primary_listener_arn = var.enable_tls ? aws_lb_listener.https[0].arn : aws_lb_listener.http.arn
}

# control-api rules
resource "aws_lb_listener_rule" "control" {
  count        = length(local.control_path_groups)
  listener_arn = local.primary_listener_arn
  priority     = 10 + count.index

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.control.arn
  }

  condition {
    path_pattern {
      values = local.control_path_groups[count.index]
    }
  }

  dynamic "condition" {
    for_each = local.use_host_routing ? [1] : []
    content {
      host_header {
        values = [local.api_host]
      }
    }
  }
}

# gateway carve-out rule (only needed when web is the default target)
resource "aws_lb_listener_rule" "gateway" {
  count        = var.enable_web ? 1 : 0
  listener_arn = local.primary_listener_arn
  priority     = 30

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway.arn
  }

  dynamic "condition" {
    for_each = local.use_host_routing ? [1] : []
    content {
      host_header {
        values = [local.api_host]
      }
    }
  }

  dynamic "condition" {
    for_each = local.use_host_routing ? [] : [1]
    content {
      path_pattern {
        values = local.gateway_paths
      }
    }
  }
}

# --- container definitions -------------------------------------------------

locals {
  # Graceful-drain coupling: the app's SHUTDOWN_GRACE_MS backstop MUST fire a few seconds
  # BEFORE ECS SIGKILL (the container stopTimeout), or an in-flight SSE stream is cut
  # mid-drain and its single teardown() (budget-commit + ledger + hash-chained audit row)
  # never runs. Derive the app grace from the stop timeout minus a small buffer so the two
  # stay coupled, and reuse the same stopTimeout literal on the containers below.
  ecs_stop_timeout_seconds = 120
  shutdown_grace_ms        = (local.ecs_stop_timeout_seconds - 10) * 1000

  # Gateway-brokered OAuth inference auth: BOTH planes carry the flag (the control-api
  # mints gko_at_ tokens; the gateway verifies them against the shared grant table with
  # the same key pepper). Extra env maps let an operator add any documented knob
  # (.env.example) without editing the module.
  oauth_env = var.enable_oauth_broker ? { OAUTH_BROKER_ENABLED = "true" } : {}

  # Node heap cap: ~75% of the task memory. An uncapped heap grows into the cgroup
  # limit and is OOM-killed mid-stream instead of collecting.
  gateway_node_options = "--max-old-space-size=${floor(local.gw_memory * 0.75)}"
  control_node_options = "--max-old-space-size=${floor(local.control_memory * 0.75)}"

  # WORM-live (prod tier): the control plane mirrors the audit chain to the Object Lock
  # bucket, signed with the audit-export CMK. Previously the bucket existed but no task
  # ever wrote to it. The migrations dir is where the bundled image copies them.
  worm_env = local.enable_worm ? {
    WORM_ENABLED                 = "true"
    WORM_BUCKET                  = local.worm_bucket_name
    WORM_REGION                  = var.aws_region
    WORM_RETENTION_DAYS          = tostring(local.worm_retention_days)
    GULLEY_AUDIT_SIGNING_KMS_ARN = aws_kms_key.this["audit-export"].arn
    GULLEY_KMS_REGION            = var.aws_region
  } : {}

  gateway_env = merge({
    NODE_ENV           = "production"
    GATEWAY_PORT       = tostring(local.ports.gateway)
    BEDROCK_REGION     = var.aws_region
    SHUTDOWN_GRACE_MS  = tostring(local.shutdown_grace_ms)
    NODE_OPTIONS       = local.gateway_node_options
    REDIS_CACHE_URL    = "rediss://${local.redis_endpoints["cache"]}:6379"
    REDIS_COUNTERS_URL = "rediss://${local.redis_endpoints["counters"]}:6379"
    REDIS_VECTOR_URL   = "rediss://${local.redis_endpoints["vector"]}:6379"
  }, local.oauth_env, var.gateway_extra_env)
  gateway_secrets = {
    GULLEY_KEY_PEPPER          = aws_secretsmanager_secret.this["gulley/key-pepper"].arn
    DATABASE_URL               = aws_secretsmanager_secret.this["gulley/db-url"].arn
    ANTHROPIC_UPSTREAM_API_KEY = aws_secretsmanager_secret.this["gulley/provider-anthropic"].arn
    OPENAI_UPSTREAM_API_KEY    = aws_secretsmanager_secret.this["gulley/provider-openai"].arn
    BEDROCK_UPSTREAM_API_KEY   = aws_secretsmanager_secret.this["gulley/provider-bedrock"].arn
  }

  control_env = merge({
    NODE_ENV         = "production"
    CONTROL_API_PORT = tostring(local.ports.control)
    # The gateway + control-api share the api host; the console is the base host. The
    # control-api needs all three: client configs point agents at the gateway, the OAuth
    # broker publishes its issuer (RFC 8414), and device-flow consent goes to the console.
    GATEWAY_PUBLIC_URL     = local.api_base_url
    CONTROL_API_PUBLIC_URL = local.api_base_url
    CONSOLE_PUBLIC_URL     = var.enable_web ? local.base_url : local.api_base_url
    SHUTDOWN_GRACE_MS      = tostring(local.shutdown_grace_ms)
    NODE_OPTIONS           = local.control_node_options
    }, var.bootstrap_admin_token_sha256 != "" ? {
    CONTROL_API_BOOTSTRAP_ENABLED       = "true"
    GULLEY_BOOTSTRAP_ADMIN_TOKEN_SHA256 = var.bootstrap_admin_token_sha256
  } : {}, local.oauth_env, local.worm_env, var.control_extra_env)
  control_secrets = merge({
    GULLEY_KEY_PEPPER           = aws_secretsmanager_secret.this["gulley/key-pepper"].arn
    GULLEY_ADMIN_SESSION_SECRET = aws_secretsmanager_secret.this["gulley/admin-session-secret"].arn
    DATABASE_URL                = aws_secretsmanager_secret.this["gulley/db-url"].arn
    }, var.enable_onboarding_packs ? {
    ONBOARDING_SIGNING_KEY = aws_secretsmanager_secret.this["gulley/onboarding-signing-key"].arn
  } : {})

  web_env = {
    NODE_ENV        = "production"
    CONTROL_API_URL = local.api_base_url
    PORT            = tostring(local.ports.web)
    HOSTNAME        = "0.0.0.0"
  }

  api_image = "${aws_ecr_repository.this["api"].repository_url}:${var.image_tag}"
  web_image = var.enable_web ? "${aws_ecr_repository.this["web"].repository_url}:${var.web_image_tag}" : ""

  log_opts = { region = var.aws_region, group = aws_cloudwatch_log_group.this.name }

  # The image is distroless (node is the ENTRYPOINT; no shell): commands are the
  # bundled entry files under /app/dist, and health checks run through node in exec
  # form. The root filesystem is read-only (nothing writes to disk; /tmp is unused).
  gateway_container = [{
    name                   = "gateway"
    image                  = local.api_image
    essential              = true
    command                = ["dist/gateway/main.mjs"]
    readonlyRootFilesystem = true
    linuxParameters        = { initProcessEnabled = true }
    portMappings           = [{ containerPort = local.ports.gateway, protocol = "tcp" }]
    environment            = [for k, v in local.gateway_env : { name = k, value = v }]
    secrets                = [for k, v in local.gateway_secrets : { name = k, valueFrom = v }]
    stopTimeout            = local.ecs_stop_timeout_seconds
    healthCheck = {
      command     = ["CMD", "/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:${local.ports.gateway}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    logConfiguration = {
      logDriver = "awslogs"
      options   = { "awslogs-group" = local.log_opts.group, "awslogs-region" = local.log_opts.region, "awslogs-stream-prefix" = "gateway" }
    }
  }]

  control_container = [{
    name                   = "control-api"
    image                  = local.api_image
    essential              = true
    command                = ["dist/control-api/main.mjs"]
    readonlyRootFilesystem = true
    linuxParameters        = { initProcessEnabled = true }
    portMappings           = [{ containerPort = local.ports.control, protocol = "tcp" }]
    environment            = [for k, v in local.control_env : { name = k, value = v }]
    secrets                = [for k, v in local.control_secrets : { name = k, valueFrom = v }]
    stopTimeout            = local.ecs_stop_timeout_seconds
    healthCheck = {
      command     = ["CMD", "/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:${local.ports.control}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    logConfiguration = {
      logDriver = "awslogs"
      options   = { "awslogs-group" = local.log_opts.group, "awslogs-region" = local.log_opts.region, "awslogs-stream-prefix" = "control-api" }
    }
  }]

  web_container = [{
    name            = "web"
    image           = local.web_image
    essential       = true
    linuxParameters = { initProcessEnabled = true }
    portMappings    = [{ containerPort = local.ports.web, protocol = "tcp" }]
    environment     = [for k, v in local.web_env : { name = k, value = v }]
    stopTimeout     = 30
    logConfiguration = {
      logDriver = "awslogs"
      options   = { "awslogs-group" = local.log_opts.group, "awslogs-region" = local.log_opts.region, "awslogs-stream-prefix" = "web" }
    }
  }]

  migrate_container = [{
    name            = "migrate"
    image           = local.api_image
    essential       = true
    command         = ["dist/control-api/migrate.mjs"]
    linuxParameters = { initProcessEnabled = true }
    environment     = [{ name = "NODE_ENV", value = "production" }]
    secrets         = [{ name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.this["gulley/db-url"].arn }]
    logConfiguration = {
      logDriver = "awslogs"
      options   = { "awslogs-group" = local.log_opts.group, "awslogs-region" = local.log_opts.region, "awslogs-stream-prefix" = "migrate" }
    }
  }]
}

# --- task definitions ------------------------------------------------------

resource "aws_ecs_task_definition" "gateway" {
  family                   = "${var.name}-gateway"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = local.gw_cpu
  memory                   = local.gw_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.gateway_task.arn
  container_definitions    = jsonencode(local.gateway_container)
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }
  tags = var.tags
}

resource "aws_ecs_task_definition" "control" {
  family                   = "${var.name}-control-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = local.control_cpu
  memory                   = local.control_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.control_task.arn
  container_definitions    = jsonencode(local.control_container)
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }
  tags = var.tags
}

resource "aws_ecs_task_definition" "web" {
  count                    = var.enable_web ? 1 : 0
  family                   = "${var.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = local.web_cpu
  memory                   = local.web_memory
  execution_role_arn       = aws_iam_role.execution.arn
  container_definitions    = jsonencode(local.web_container)
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }
  tags = var.tags
}

# One-off migration task (run via `aws ecs run-task`; never a service).
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.gateway_task.arn
  container_definitions    = jsonencode(local.migrate_container)
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }
  tags = var.tags
}

# --- services --------------------------------------------------------------

resource "aws_ecs_service" "gateway" {
  name                              = "${var.name}-gateway"
  cluster                           = aws_ecs_cluster.this.id
  task_definition                   = aws_ecs_task_definition.gateway.arn
  desired_count                     = local.gw_desired
  launch_type                       = local.use_fargate_spot ? null : "FARGATE"
  health_check_grace_period_seconds = 90

  dynamic "capacity_provider_strategy" {
    for_each = local.use_fargate_spot ? [1] : []
    content {
      capacity_provider = "FARGATE_SPOT"
      weight            = 1
    }
  }

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.gateway.arn
    container_name   = "gateway"
    container_port   = local.ports.gateway
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.http]
  tags       = var.tags

  lifecycle {
    ignore_changes = [desired_count] # let autoscaling own it once running
  }
}

resource "aws_ecs_service" "control" {
  name            = "${var.name}-control-api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.control.arn
  desired_count   = local.control_desired
  launch_type     = local.use_fargate_spot ? null : "FARGATE"

  dynamic "capacity_provider_strategy" {
    for_each = local.use_fargate_spot ? [1] : []
    content {
      capacity_provider = "FARGATE_SPOT"
      weight            = 1
    }
  }

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.control.arn
    container_name   = "control-api"
    container_port   = local.ports.control
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.http]
  tags       = var.tags
}

resource "aws_ecs_service" "web" {
  count           = var.enable_web ? 1 : 0
  name            = "${var.name}-web"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.web[0].arn
  desired_count   = local.web_desired
  launch_type     = local.use_fargate_spot ? null : "FARGATE"

  dynamic "capacity_provider_strategy" {
    for_each = local.use_fargate_spot ? [1] : []
    content {
      capacity_provider = "FARGATE_SPOT"
      weight            = 1
    }
  }

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web[0].arn
    container_name   = "web"
    container_port   = local.ports.web
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.http]
  tags       = var.tags
}

# --- autoscaling (gateway; request-count proxy for connection load) --------

resource "aws_appautoscaling_target" "gateway" {
  count              = var.enable_services ? 1 : 0
  max_capacity       = local.max_capacity
  min_capacity       = local.min_capacity
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.gateway.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "gateway_requests" {
  count              = var.enable_services ? 1 : 0
  name               = "${var.name}-gateway-requests"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.gateway[0].resource_id
  scalable_dimension = aws_appautoscaling_target.gateway[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.gateway[0].service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.this.arn_suffix}/${aws_lb_target_group.gateway.arn_suffix}"
    }
    target_value       = 500
    scale_in_cooldown  = 120
    scale_out_cooldown = 30
  }
}
