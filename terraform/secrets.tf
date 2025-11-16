# Random password for RDS master user
resource "random_password" "db_password" {
  length  = 32
  special = true
  # Avoid characters that might cause issues in connection strings
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

# Secrets Manager Secret for Database Credentials
resource "aws_secretsmanager_secret" "db_credentials" {
  name                    = "${var.project_name}-${var.environment}-db-credentials"
  description             = "Database credentials for flexi-day-be application"
  recovery_window_in_days = 7

  tags = {
    Name = "${var.project_name}-${var.environment}-db-credentials"
  }
}

# Secrets Manager Secret Version with Database Credentials
resource "aws_secretsmanager_secret_version" "db_credentials" {
  secret_id = aws_secretsmanager_secret.db_credentials.id

  secret_string = jsonencode({
    username             = var.db_username
    password             = random_password.db_password.result
    engine               = "postgres"
    host                 = aws_db_instance.main.address
    port                 = aws_db_instance.main.port
    dbname               = var.db_name
    dbInstanceIdentifier = aws_db_instance.main.id
    # Connection string for the application
    connection_string = "postgresql://${var.db_username}:${random_password.db_password.result}@${aws_db_instance.main.address}:${aws_db_instance.main.port}/${var.db_name}"
  })
}

# Secrets Manager Secret for Application Configuration
resource "aws_secretsmanager_secret" "app_config" {
  name                    = "${var.project_name}-${var.environment}-app-config"
  description             = "Application configuration secrets for flexi-day-be"
  recovery_window_in_days = 7

  tags = {
    Name = "${var.project_name}-${var.environment}-app-config"
  }
}

# Application Configuration Secret Version
resource "aws_secretsmanager_secret_version" "app_config" {
  secret_id = aws_secretsmanager_secret.app_config.id

  secret_string = jsonencode({
    BETTER_AUTH_SECRET = var.better_auth_secret != "" ? var.better_auth_secret : random_password.better_auth_secret.result
    BETTER_AUTH_URL    = var.better_auth_url
    NODE_ENV           = var.environment == "production" ? "production" : "dev"
  })
}

# Random password for Better Auth Secret (if not provided)
resource "random_password" "better_auth_secret" {
  length  = 64
  special = true
}

# IAM Policy for EC2 to access app config secret
resource "aws_iam_role_policy" "app_config_access" {
  name = "${var.project_name}-${var.environment}-app-config-access"
  role = aws_iam_role.ec2.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret"
        ]
        Resource = [
          aws_secretsmanager_secret.app_config.arn
        ]
      }
    ]
  })
}