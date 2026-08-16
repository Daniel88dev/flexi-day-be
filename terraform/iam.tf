# IAM roles for App Runner. There are two distinct roles:
#
# 1. "access role"  - assumed by App Runner's BUILD service to pull the
#    container image from your private ECR repository.
# 2. "instance role" - assumed by the RUNNING application instances; used
#    here to resolve the Secrets Manager values injected as env vars.

# --- 1. ECR access role -----------------------------------------------------
resource "aws_iam_role" "apprunner_ecr_access" {
  name = "${var.project_name}-${var.environment}-apprunner-ecr-access"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "build.apprunner.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name = "${var.project_name}-${var.environment}-apprunner-ecr-access"
  }
}

resource "aws_iam_role_policy_attachment" "apprunner_ecr_access" {
  role       = aws_iam_role.apprunner_ecr_access.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess"
}

# --- 2. Instance role -------------------------------------------------------
resource "aws_iam_role" "apprunner_instance" {
  name = "${var.project_name}-${var.environment}-apprunner-instance"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "tasks.apprunner.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name = "${var.project_name}-${var.environment}-apprunner-instance"
  }
}

# Allow the running service to read the two secrets injected as env vars
resource "aws_iam_role_policy" "apprunner_secrets" {
  name = "${var.project_name}-${var.environment}-apprunner-secrets"
  role = aws_iam_role.apprunner_instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret"
        ]
        Resource = concat(
          [
            aws_secretsmanager_secret.database_url.arn,
            aws_secretsmanager_secret.better_auth_secret.arn
          ],
          aws_secretsmanager_secret.google_client_secret[*].arn,
          aws_secretsmanager_secret.paddle_api_key[*].arn,
          aws_secretsmanager_secret.paddle_webhook_secret[*].arn
        )
      }
    ]
  })
}

# Allow the running service to send transactional email via SESv2.
#
# Resource MUST be "*": templated sends (SESv2 SendEmail with a Template maps
# to the `ses:SendTemplatedEmail` action) evaluate the IAM resource against the
# *recipient* identity, not the sender — and in the SES sandbox every send is
# checked this way. Recipients are arbitrary user emails, so they can't be
# enumerated in an ARN list; scoping to `identity/flexi-day.com` denied every
# real signup. Sending is still constrained by SES itself (the From address
# must be a verified identity, or SES rejects the message), and the
# `ses:FromAddress` condition below restricts which sender this role may use.
#
# `ses:SendEmail` covers SESv2; `ses:SendTemplatedEmail` is what the templated
# path actually authorizes against.
resource "aws_iam_role_policy" "apprunner_ses" {
  name = "${var.project_name}-${var.environment}-apprunner-ses"
  role = aws_iam_role.apprunner_instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ses:SendEmail",
          "ses:SendTemplatedEmail"
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "ses:FromAddress" = var.email_from
          }
        }
      }
    ]
  })
}

# --- Developer database access via IAM authentication ----------------------
# Lets the named IAM user connect to Postgres as the "${var.db_iam_login}"
# database role using a short-lived token (aws rds generate-db-auth-token)
# instead of the master password. The matching Postgres role must exist and
# have been GRANTed rds_iam.
resource "aws_iam_user_policy" "developer_rds_connect" {
  name = "${var.project_name}-${var.environment}-rds-iam-connect"
  user = var.developer_iam_username

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["rds-db:connect"]
        Resource = "arn:aws:rds-db:${var.aws_region}:${data.aws_caller_identity.current.account_id}:dbuser:${aws_db_instance.main.resource_id}/${var.db_iam_login}"
      }
    ]
  })
}

# Data source to get current AWS account ID
data "aws_caller_identity" "current" {}
