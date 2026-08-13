resource "aws_ecs_cluster" "this" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  tags = var.tags
}

# --- ALB (SSE-tuned) --------------------------------------------------------

resource "aws_lb" "this" {
  name                       = var.name
  load_balancer_type         = "application"
  security_groups            = [var.alb_security_group_id]
  subnets                    = var.public_subnet_ids
  idle_timeout               = 300 # SSE streams; the 60s default kills them
  drop_invalid_header_fields = true
  enable_http2               = true
  tags                       = var.tags
}

resource "aws_lb_target_group" "gateway" {
  name                 = "${var.name}-gw"
  port                 = var.gateway_port
  protocol             = "HTTP"
  vpc_id               = var.vpc_id
  target_type          = "ip"
  deregistration_delay = 180 # let in-flight streams drain before dropping the target

  health_check {
    path                = "/health"
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
  port                 = var.control_port
  protocol             = "HTTP"
  vpc_id               = var.vpc_id
  target_type          = "ip"
  deregistration_delay = 60

  health_check {
    path    = "/health"
    matcher = "200"
  }
  tags = var.tags
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway.arn
  }
}

# Control-plane surfaces route to the control-api service by path.
resource "aws_lb_listener_rule" "control" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.control.arn
  }
  condition {
    path_pattern {
      values = ["/admin/*", "/oauth/*", "/config/*"]
    }
  }
}

# --- task definitions -------------------------------------------------------

locals {
  gateway_container = [{
    name            = "gateway"
    image           = var.image
    essential       = true
    command         = ["node", "--import", "tsx", "apps/gateway/src/main.ts"]
    linuxParameters = { initProcessEnabled = true }
    portMappings    = [{ containerPort = var.gateway_port, protocol = "tcp" }]
    environment     = [for k, v in var.gateway_env : { name = k, value = v }]
    secrets         = [for k, v in var.gateway_secrets : { name = k, valueFrom = v }]
    stopTimeout     = 120
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:${var.gateway_port}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = var.log_group_name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "gateway"
      }
    }
  }]

  control_container = [{
    name            = "control-api"
    image           = var.image
    essential       = true
    command         = ["node", "--import", "tsx", "apps/control-api/src/main.ts"]
    linuxParameters = { initProcessEnabled = true }
    portMappings    = [{ containerPort = var.control_port, protocol = "tcp" }]
    environment     = [for k, v in var.control_env : { name = k, value = v }]
    secrets         = [for k, v in var.control_secrets : { name = k, valueFrom = v }]
    stopTimeout     = 120
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = var.log_group_name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "control-api"
      }
    }
  }]
}

resource "aws_ecs_task_definition" "gateway" {
  family                   = "${var.name}-gateway"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.gateway_task_role_arn
  container_definitions    = jsonencode(local.gateway_container)
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  tags = var.tags
}

resource "aws_ecs_task_definition" "control" {
  family                   = "${var.name}-control-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.control_task_role_arn
  container_definitions    = jsonencode(local.control_container)
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  tags = var.tags
}

# --- services ---------------------------------------------------------------

resource "aws_ecs_service" "gateway" {
  name                              = "${var.name}-gateway"
  cluster                           = aws_ecs_cluster.this.id
  task_definition                   = aws_ecs_task_definition.gateway.arn
  desired_count                     = var.desired_count
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 60

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.service_security_group_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.gateway.arn
    container_name   = "gateway"
    container_port   = var.gateway_port
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.https]
  tags       = var.tags
}

resource "aws_ecs_service" "control" {
  name            = "${var.name}-control-api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.control.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.service_security_group_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.control.arn
    container_name   = "control-api"
    container_port   = var.control_port
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.https]
  tags       = var.tags
}

# --- autoscaling (request-count proxy for connection load) ------------------

resource "aws_appautoscaling_target" "gateway" {
  max_capacity       = var.max_capacity
  min_capacity       = var.min_capacity
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.gateway.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "gateway_requests" {
  name               = "${var.name}-gateway-requests"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.gateway.resource_id
  scalable_dimension = aws_appautoscaling_target.gateway.scalable_dimension
  service_namespace  = aws_appautoscaling_target.gateway.service_namespace

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
