# Random password for RDS master user.
# The password is URL-encoded when embedded in the connection string, so any
# special character is safe here.
resource "random_password" "db_password" {
  length           = 32
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

# The Better Auth secret before versioning. It is version 1 below, and it
# stays fixed: rotating it would make every row encrypted under it unreadable.
# The keepers once tied it to a 90-day time_rotating window, which replaced
# the key outright; ignoring them keeps the value this state already holds.
resource "random_password" "better_auth_secret" {
  length  = 64
  special = false

  lifecycle {
    ignore_changes = [keepers]
  }
}

# Better Auth secret versions. better-auth encrypts and signs with the newest
# and decrypts with every version listed, so a rotation adds a version and
# keeps the previous one for what is still encrypted under it. The backend
# re-encrypts those rows onto the newest version at boot, which is what makes
# two versions enough. Rotate by raising better_auth_secret_version by one;
# docs/terraform.md has the runbook.
locals {
  better_auth_secret_versions = [
    for v in [var.better_auth_secret_version, var.better_auth_secret_version - 1] : v if v >= 1
  ]

  # Version 1 is the secret the backend ran with before versioning, so moving
  # to versions changes no key and signs nobody out.
  better_auth_secret_values = merge(
    {
      "1" = var.better_auth_secret != "" ? var.better_auth_secret : random_password.better_auth_secret.result
    },
    { for v, secret in random_password.better_auth_secret_version : v => secret.result }
  )
}

resource "random_password" "better_auth_secret_version" {
  for_each = toset([for v in local.better_auth_secret_versions : tostring(v) if v >= 2])

  length  = 64
  special = false
}

resource "time_static" "better_auth_secret_version" {
  for_each = toset([for v in local.better_auth_secret_versions : tostring(v)])
}

check "better_auth_secret_age" {
  assert {
    condition = timecmp(
      plantimestamp(),
      timeadd(
        time_static.better_auth_secret_version[tostring(var.better_auth_secret_version)].rfc3339,
        "${var.better_auth_rotation_days * 24}h"
      )
    ) < 0
    error_message = "Better Auth secret version ${var.better_auth_secret_version} is older than ${var.better_auth_rotation_days} days. Rotate it by raising better_auth_secret_version by one (docs/terraform.md)."
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

# The single-secret slot from before versioning. It keeps version 1's value and
# is still injected as BETTER_AUTH_SECRET, so a rollback to an image that reads
# only that variable boots with the right key. Remove it, and its line in
# apprunner.tf and iam.tf, once versioning has been through a rotation.
resource "aws_secretsmanager_secret" "better_auth_secret" {
  name                    = "${var.project_name}-${var.environment}-better-auth-secret"
  description             = "Better Auth signing secret for ${var.project_name}"
  recovery_window_in_days = 0

  tags = {
    Name = "${var.project_name}-${var.environment}-better-auth-secret"
  }
}

resource "aws_secretsmanager_secret_version" "better_auth_secret" {
  secret_id     = aws_secretsmanager_secret.better_auth_secret.id
  secret_string = local.better_auth_secret_values["1"]
}

# BETTER_AUTH_SECRETS: `<version>:<secret>` pairs, newest first, in the format
# better-auth reads. One string, because App Runner maps one env var to one
# secret. Neither the version nor the 64 alphanumeric characters can hold a
# comma or a colon.
resource "aws_secretsmanager_secret" "better_auth_secrets" {
  name                    = "${var.project_name}-${var.environment}-better-auth-secrets"
  description             = "Better Auth secret versions for ${var.project_name}"
  recovery_window_in_days = 0

  tags = {
    Name = "${var.project_name}-${var.environment}-better-auth-secrets"
  }
}

resource "aws_secretsmanager_secret_version" "better_auth_secrets" {
  secret_id = aws_secretsmanager_secret.better_auth_secrets.id
  secret_string = join(",", [
    for v in local.better_auth_secret_versions : "${v}:${local.better_auth_secret_values[tostring(v)]}"
  ])
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

# The two Apple .p8 keys below are the exception to the shape above: Terraform
# owns the slot and never the value. terraform/scripts/put-p8.sh uploads each
# key from 1Password, so neither reaches state or a plan. Each switched-on key
# is read back by an ephemeral resource, which stores nothing, and its
# postcondition stops the plan when the slot is empty or holds something other
# than a PEM private key. docs/terraform.md has the runbooks.

# Sign in with Apple. Like the APNs slot it always exists, so the key can go up
# before apple_client_id switches it into the service.
resource "aws_secretsmanager_secret" "apple_private_key" {
  name                    = "${var.project_name}-${var.environment}-apple-private-key"
  description             = "Sign in with Apple private key (.p8) for ${var.project_name}"
  recovery_window_in_days = 0

  tags = {
    Name = "${var.project_name}-${var.environment}-apple-private-key"
  }

  # A Services ID without its team, key id or bundle id leaves better-auth
  # unable to mint a client secret; fail at plan time instead of booting a
  # service whose Apple button 500s.
  lifecycle {
    precondition {
      condition     = var.apple_client_id == "" || (var.apple_team_id != "" && var.apple_key_id != "" && var.apple_app_bundle_identifier != "")
      error_message = "apple_team_id, apple_key_id and apple_app_bundle_identifier are required when apple_client_id is set."
    }
  }
}

moved {
  from = aws_secretsmanager_secret.apple_private_key[0]
  to   = aws_secretsmanager_secret.apple_private_key
}

# The key used to be written from TF_VAR_apple_private_key. Forgetting the
# version leaves the live AWSCURRENT value in place.
removed {
  from = aws_secretsmanager_secret_version.apple_private_key

  lifecycle {
    destroy = false
  }
}

ephemeral "aws_secretsmanager_secret_version" "apple_private_key" {
  count     = var.apple_client_id != "" ? 1 : 0
  secret_id = aws_secretsmanager_secret.apple_private_key.id

  lifecycle {
    postcondition {
      condition     = startswith(self.secret_string, "-----BEGIN PRIVATE KEY-----")
      error_message = "The Sign in with Apple slot does not hold a PEM private key. Upload it with terraform/scripts/put-p8.sh apple."
    }
  }
}

# APNs. The slot always exists, so the key can go up before App Runner needs
# it; apns_key_id is what wires it into the service.
resource "aws_secretsmanager_secret" "apns_private_key" {
  name                    = "${var.project_name}-${var.environment}-apns-private-key"
  description             = "APNs auth key (.p8) for ${var.project_name}"
  recovery_window_in_days = 0

  tags = {
    Name = "${var.project_name}-${var.environment}-apns-private-key"
  }

  lifecycle {
    precondition {
      condition     = var.apns_key_id == "" || (var.apple_team_id != "" && var.apple_app_bundle_identifier != "")
      error_message = "apple_team_id and apple_app_bundle_identifier are required when apns_key_id is set."
    }
  }
}

ephemeral "aws_secretsmanager_secret_version" "apns_private_key" {
  count     = var.apns_key_id != "" ? 1 : 0
  secret_id = aws_secretsmanager_secret.apns_private_key.id

  lifecycle {
    postcondition {
      condition     = startswith(self.secret_string, "-----BEGIN PRIVATE KEY-----")
      error_message = "The APNs slot does not hold a PEM private key. Upload it with terraform/scripts/put-p8.sh apns."
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

# HMAC key the attachment-processor Lambda signs its callback with and App
# Runner verifies (docs/adr/0003). Generated here, never typed in; both sides
# read it from Secrets Manager. Rotate with
# `terraform taint random_password.attachments_callback_secret` and an apply,
# then `aws apprunner start-deployment`: App Runner resolves a secret at
# deployment time and keeps the old value until then. The Lambda re-reads the
# secret whenever the API refuses a callback (401), so warm containers follow
# on their next report; callbacks refused in between are retried.
resource "random_password" "attachments_callback_secret" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "attachments_callback_secret" {
  name                    = "${var.project_name}-${var.environment}-attachments-callback-secret"
  description             = "HMAC key for the attachment-processor callback of ${var.project_name}"
  recovery_window_in_days = 0

  tags = {
    Name = "${var.project_name}-${var.environment}-attachments-callback-secret"
  }
}

resource "aws_secretsmanager_secret_version" "attachments_callback_secret" {
  secret_id     = aws_secretsmanager_secret.attachments_callback_secret.id
  secret_string = random_password.attachments_callback_secret.result
}
