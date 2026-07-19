# App Runner service running the container image from ECR.
#
# Redeploy story: the service watches the ECR tag (var.docker_image_tag,
# e.g. "main"). Every time CI pushes a new image to that tag, App Runner
# automatically rolls out a new deployment (auto_deployments_enabled).
# Manual redeploy: aws apprunner start-deployment --service-arn <arn>

# VPC connector: gives the service network interfaces inside the private
# subnets so it can reach RDS. NOTE: with egress_type = "VPC", ALL outbound
# traffic from the app is routed into the VPC — which has no internet path.
resource "aws_apprunner_vpc_connector" "main" {
  vpc_connector_name = "${var.project_name}-${var.environment}-vpc-connector"
  subnets            = aws_subnet.private[*].id
  security_groups    = [aws_security_group.app.id]

  tags = {
    Name = "${var.project_name}-${var.environment}-vpc-connector"
  }
}

# Cap scaling so a traffic spike (or attack) can't run up the bill.
resource "aws_apprunner_auto_scaling_configuration_version" "main" {
  auto_scaling_configuration_name = "${var.project_name}-${var.environment}"
  min_size                        = 1
  max_size                        = var.apprunner_max_size
  max_concurrency                 = 100

  tags = {
    Name = "${var.project_name}-${var.environment}-autoscaling"
  }
}

resource "aws_apprunner_service" "main" {
  service_name = "${var.project_name}-${var.environment}"

  source_configuration {
    auto_deployments_enabled = true

    authentication_configuration {
      access_role_arn = aws_iam_role.apprunner_ecr_access.arn
    }

    image_repository {
      image_repository_type = "ECR"
      image_identifier      = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/${var.ecr_repository_name}:${var.docker_image_tag}"

      image_configuration {
        port = tostring(var.app_port)

        runtime_environment_variables = {
          NODE_ENV        = var.environment == "production" ? "production" : "dev"
          PORT            = tostring(var.app_port)
          BETTER_AUTH_URL = "https://${var.api_domain_name}"
          TRUSTED_ORIGINS = join(",", var.trusted_origins)
          RUN_MIGRATIONS  = "true"
        }

        # Resolved at instance start via the instance role; each env var
        # receives the referenced secret's full string value.
        runtime_environment_secrets = {
          DATABASE           = aws_secretsmanager_secret.database_url.arn
          BETTER_AUTH_SECRET = aws_secretsmanager_secret.better_auth_secret.arn
        }
      }
    }
  }

  instance_configuration {
    cpu               = var.apprunner_cpu
    memory            = var.apprunner_memory
    instance_role_arn = aws_iam_role.apprunner_instance.arn
  }

  health_check_configuration {
    protocol            = "HTTP"
    path                = "/health"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 1
    unhealthy_threshold = 5
  }

  network_configuration {
    ingress_configuration {
      is_publicly_accessible = true
    }
    egress_configuration {
      egress_type       = "VPC"
      vpc_connector_arn = aws_apprunner_vpc_connector.main.arn
    }
  }

  auto_scaling_configuration_arn = aws_apprunner_auto_scaling_configuration_version.main.arn

  # Secret values must exist before the first deployment resolves them, and
  # the DB must accept connections for startup migrations to succeed.
  depends_on = [
    aws_secretsmanager_secret_version.database_url,
    aws_secretsmanager_secret_version.better_auth_secret,
    aws_iam_role_policy.apprunner_secrets,
    aws_db_instance.main
  ]

  tags = {
    Name = "${var.project_name}-${var.environment}"
  }
}
