# Random password for RDS master user.
# The password is URL-encoded when embedded in the connection string, so any
# special character is safe here.
resource "random_password" "db_password" {
  length           = 32
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

# Scheduled rotation window for the Better Auth secret. `time_rotating` stores
# a rotation timestamp in state and only advances it once the window elapses;
# incidental `terraform apply` runs in between leave it unchanged. Advancing it
# is the ONLY thing that rotates the secret below (and thus signs out every
# active session + invalidates pending verify/reset tokens once per window).
resource "time_rotating" "better_auth_secret_rotation" {
  rotation_days = var.better_auth_rotation_days
}

# Random Better Auth secret (used unless var.better_auth_secret is set).
# `keepers` ties the value to the rotation window: the secret is regenerated
# only when time_rotating advances, i.e. at most once per rotation_days.
resource "random_password" "better_auth_secret" {
  length  = 64
  special = false

  keepers = {
    rotated_at = time_rotating.better_auth_secret_rotation.rotation_rfc3339
  }
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

# Google OAuth client secret. Only provisioned when Google sign-in is enabled
# (i.e. google_client_id is set), so the whole integration is opt-in and an
# empty secret_string never reaches Secrets Manager. The client id itself is
# public and injected as a plain env var in apprunner.tf.
resource "aws_secretsmanager_secret" "google_client_secret" {
  count                   = var.google_client_id != "" ? 1 : 0
  name                    = "${var.project_name}-${var.environment}-google-client-secret"
  description             = "Google OAuth client secret for ${var.project_name}"
  recovery_window_in_days = 0

  tags = {
    Name = "${var.project_name}-${var.environment}-google-client-secret"
  }
}

resource "aws_secretsmanager_secret_version" "google_client_secret" {
  count         = var.google_client_id != "" ? 1 : 0
  secret_id     = aws_secretsmanager_secret.google_client_secret[0].id
  secret_string = var.google_client_secret
}

# Microsoft Entra ID client secret, same opt-in shape as Google above. The
# application (client) id and the tenant id are both public and injected as
# plain env vars in apprunner.tf.
resource "aws_secretsmanager_secret" "microsoft_client_secret" {
  count                   = var.microsoft_client_id != "" ? 1 : 0
  name                    = "${var.project_name}-${var.environment}-microsoft-client-secret"
  description             = "Microsoft Entra ID client secret for ${var.project_name}"
  recovery_window_in_days = 0

  tags = {
    Name = "${var.project_name}-${var.environment}-microsoft-client-secret"
  }
}

resource "aws_secretsmanager_secret_version" "microsoft_client_secret" {
  count         = var.microsoft_client_id != "" ? 1 : 0
  secret_id     = aws_secretsmanager_secret.microsoft_client_secret[0].id
  secret_string = var.microsoft_client_secret

  # Entra client secrets expire (24 months at most), and a half-configured
  # rotation is the likely failure mode. Catch it at plan time rather than
  # letting App Runner boot a service whose Microsoft button 500s.
  lifecycle {
    precondition {
      condition     = var.microsoft_client_secret != ""
      error_message = "microsoft_client_secret is required when microsoft_client_id is set."
    }
  }
}

# Paddle API key and webhook signing secret. Only provisioned when billing is
# enabled (paddle_api_key set), matching the google_client_secret pattern
# above, so an empty secret_string never reaches Secrets Manager. The six
# price IDs are not secrets and are injected as plain env vars in apprunner.tf.
resource "aws_secretsmanager_secret" "paddle_api_key" {
  count                   = var.paddle_api_key != "" ? 1 : 0
  name                    = "${var.project_name}-${var.environment}-paddle-api-key"
  description             = "Paddle API key for ${var.project_name}"
  recovery_window_in_days = 0

  tags = {
    Name = "${var.project_name}-${var.environment}-paddle-api-key"
  }
}

resource "aws_secretsmanager_secret_version" "paddle_api_key" {
  count         = var.paddle_api_key != "" ? 1 : 0
  secret_id     = aws_secretsmanager_secret.paddle_api_key[0].id
  secret_string = var.paddle_api_key

  # Fail at plan/apply rather than letting App Runner start a container that
  # throws in config.ts — a boot loop is far harder to diagnose than this.
  lifecycle {
    precondition {
      condition     = var.paddle_webhook_secret != ""
      error_message = "paddle_webhook_secret is required when paddle_api_key is set."
    }

    precondition {
      condition = alltrue([
        for id in values(var.paddle_prices) : id != ""
      ])
      error_message = "All six paddle_prices IDs are required when paddle_api_key is set."
    }

    # Sandbox credentials must never reach the production environment; the
    # backend enforces the same rule at boot.
    precondition {
      condition     = !(var.environment == "production" && var.paddle_environment == "sandbox")
      error_message = "paddle_environment must be \"production\" when environment is \"production\"."
    }
  }
}

resource "aws_secretsmanager_secret" "paddle_webhook_secret" {
  count                   = var.paddle_api_key != "" ? 1 : 0
  name                    = "${var.project_name}-${var.environment}-paddle-webhook-secret"
  description             = "Paddle webhook signing secret for ${var.project_name}"
  recovery_window_in_days = 0

  tags = {
    Name = "${var.project_name}-${var.environment}-paddle-webhook-secret"
  }
}

resource "aws_secretsmanager_secret_version" "paddle_webhook_secret" {
  count         = var.paddle_api_key != "" ? 1 : 0
  secret_id     = aws_secretsmanager_secret.paddle_webhook_secret[0].id
  secret_string = var.paddle_webhook_secret
}
