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
  gateway_paths = ["/v1/*", "/health", "/ready", "/metrics", "/live"]
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
  gateway_env = {
    NODE_ENV           = "production"
    GATEWAY_PORT       = tostring(local.ports.gateway)
    BEDROCK_REGION     = var.aws_region
    REDIS_CACHE_URL    = "rediss://${local.redis_endpoints["cache"]}:6379"
    REDIS_COUNTERS_URL = "rediss://${local.redis_endpoints["counters"]}:6379"
    REDIS_VECTOR_URL   = "rediss://${local.redis_endpoints["vector"]}:6379"
  }
  gateway_secrets = {
    GULLEY_KEY_PEPPER          = aws_secretsmanager_secret.this["gulley/key-pepper"].arn
    DATABASE_URL               = aws_secretsmanager_secret.this["gulley/db-url"].arn
    ANTHROPIC_UPSTREAM_API_KEY = aws_secretsmanager_secret.this["gulley/provider-anthropic"].arn
    OPENAI_UPSTREAM_API_KEY    = aws_secretsmanager_secret.this["gulley/provider-openai"].arn
    BEDROCK_UPSTREAM_API_KEY   = aws_secretsmanager_secret.this["gulley/provider-bedrock"].arn
  }

  control_env = merge({
    NODE_ENV           = "production"
    CONTROL_API_PORT   = tostring(local.ports.control)
    GATEWAY_PUBLIC_URL = local.api_base_url
    }, var.bootstrap_admin_token_sha256 != "" ? {
    CONTROL_API_BOOTSTRAP_ENABLED       = "true"
    GULLEY_BOOTSTRAP_ADMIN_TOKEN_SHA256 = var.bootstrap_admin_token_sha256
  } : {})
  control_secrets = {
    GULLEY_KEY_PEPPER           = aws_secretsmanager_secret.this["gulley/key-pepper"].arn
    GULLEY_ADMIN_SESSION_SECRET = aws_secretsmanager_secret.this["gulley/admin-session-secret"].arn
    DATABASE_URL                = aws_secretsmanager_secret.this["gulley/db-url"].arn
  }

  web_env = {
    NODE_ENV        = "production"
    CONTROL_API_URL = local.api_base_url
    PORT            = tostring(local.ports.web)
    HOSTNAME        = "0.0.0.0"
  }

  api_image = "${aws_ecr_repository.this["api"].repository_url}:${var.image_tag}"
  web_image = var.enable_web ? "${aws_ecr_repository.this["web"].repository_url}:${var.web_image_tag}" : ""

  log_opts = { region = var.aws_region, group = aws_cloudwatch_log_group.this.name }

  gateway_container = [{
    name = "gateway"
    # Run from the app dir so pnpm's isolated node_modules resolve `tsx` (it lives
    # in apps/<app>/node_modules, not /app/node_modules). Matches `pnpm start`.
    workingDirectory = "/app/apps/gateway"
    image            = local.api_image
    essential        = true
    command          = ["node", "--import", "tsx", "src/main.ts"]
    linuxParameters  = { initProcessEnabled = true }
    portMappings     = [{ containerPort = local.ports.gateway, protocol = "tcp" }]
    environment      = [for k, v in local.gateway_env : { name = k, value = v }]
    secrets          = [for k, v in local.gateway_secrets : { name = k, valueFrom = v }]
    stopTimeout      = 120
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:${local.ports.gateway}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
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
    name             = "control-api"
    workingDirectory = "/app/apps/control-api"
    image            = local.api_image
    essential        = true
    command          = ["node", "--import", "tsx", "src/main.ts"]
    linuxParameters  = { initProcessEnabled = true }
    portMappings     = [{ containerPort = local.ports.control, protocol = "tcp" }]
    environment      = [for k, v in local.control_env : { name = k, value = v }]
    secrets          = [for k, v in local.control_secrets : { name = k, valueFrom = v }]
    stopTimeout      = 120
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
    command         = ["pnpm", "--filter", "@gulley/storage", "db:migrate"]
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
