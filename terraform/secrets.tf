# Random password for RDS master user.
# The password is URL-encoded when embedded in the connection string, so any
# special character is safe here.
resource "random_password" "db_password" {
  length           = 32
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

# Random Better Auth secret (used unless var.better_auth_secret is set)
resource "random_password" "better_auth_secret" {
  length  = 64
  special = false
}

# App Runner injects each secret as ONE env var containing the secret's full
# string value (it cannot extract a key out of a JSON secret), so each env
# var gets its own plain-string secret.
#
# recovery_window_in_days = 0 deletes secrets immediately on destroy. With
# the default 7-30 day recovery window, a destroy + re-apply cycle fails
# because the secret name is still "scheduled for deletion".

resource "aws_secretsmanager_secret" "database_url" {
  name                    = "${var.project_name}-${var.environment}-database-url"
  description             = "PostgreSQL connection string for ${var.project_name}"
  recovery_window_in_days = 0

  tags = {
    Name = "${var.project_name}-${var.environment}-database-url"
  }
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = "postgresql://${var.db_username}:${urlencode(random_password.db_password.result)}@${aws_db_instance.main.address}:${aws_db_instance.main.port}/${var.db_name}"
}

resource "aws_secretsmanager_secret" "better_auth_secret" {
  name                    = "${var.project_name}-${var.environment}-better-auth-secret"
  description             = "Better Auth signing secret for ${var.project_name}"
  recovery_window_in_days = 0

  tags = {
    Name = "${var.project_name}-${var.environment}-better-auth-secret"
  }
}

resource "aws_secretsmanager_secret_version" "better_auth_secret" {
  secret_id = aws_secretsmanager_secret.better_auth_secret.id
  secret_string = (
    var.better_auth_secret != ""
    ? var.better_auth_secret
    : random_password.better_auth_secret.result
  )
}
