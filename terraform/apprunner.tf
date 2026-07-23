# App Runner service running the container image from ECR.
#
# Redeploy story: the service watches the ECR tag (var.docker_image_tag,
# e.g. "main"). Every time CI pushes a new image to that tag, App Runner
# automatically rolls out a new deployment (auto_deployments_enabled).
# Manual redeploy: aws apprunner start-deployment --service-arn <arn>
#
# Networking: default public egress. The app reaches RDS over its public
# endpoint (TLS-verified) and has normal outbound internet access (Have I
# Been Pwned checks, future email provider). No VPC connector needed.

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

        runtime_environment_variables = merge(
          {
            NODE_ENV        = var.environment == "production" ? "production" : "dev"
            PORT            = tostring(var.app_port)
            BETTER_AUTH_URL = "https://${var.api_domain_name}"
            FEED_BASE_URL   = "https://${var.api_domain_name}"
            TRUSTED_ORIGINS = join(",", var.trusted_origins)

            # Transactional email (SESv2). Templates are stage-suffixed and
            # region-scoped; the instance role grants ses:SendEmail (see iam.tf).
            AWS_REGION            = var.aws_region
            EMAIL_FROM            = var.email_from
            EMAIL_TEMPLATE_STAGE  = var.environment == "production" ? "prod" : "dev"
            SES_CONFIGURATION_SET = var.environment == "production" ? "flexi-day-emails-production" : "flexi-day-emails-dev"
          },
          # Google OAuth client id is public; only set when Google sign-in is
          # enabled. The matching client secret is injected below via Secrets
          # Manager. better-auth builds the callback as
          # {BETTER_AUTH_URL}/api/auth/callback/google.
          var.google_client_id != "" ? { GOOGLE_CLIENT_ID = var.google_client_id } : {}
        )

        # Resolved at instance start via the instance role; each env var
        # receives the referenced secret's full string value.
        runtime_environment_secrets = merge(
          {
            DATABASE           = aws_secretsmanager_secret.database_url.arn
            BETTER_AUTH_SECRET = aws_secretsmanager_secret.better_auth_secret.arn
          },
          var.google_client_id != "" ? {
            GOOGLE_CLIENT_SECRET = aws_secretsmanager_secret.google_client_secret[0].arn
          } : {}
        )
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

  auto_scaling_configuration_arn = aws_apprunner_auto_scaling_configuration_version.main.arn

  # Secret values must exist before the first deployment resolves them, and
  # the schema must be migrated manually before the app can serve traffic.
  depends_on = [
    aws_secretsmanager_secret_version.database_url,
    aws_secretsmanager_secret_version.better_auth_secret,
    aws_secretsmanager_secret_version.google_client_secret,
    aws_iam_role_policy.apprunner_secrets,
    aws_db_instance.main
  ]

  tags = {
    Name = "${var.project_name}-${var.environment}"
  }
}
