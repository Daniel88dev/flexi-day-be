# General Configuration
variable "aws_region" {
  description = "AWS region for resources"
  type        = string
  default     = "eu-central-1"
}

variable "environment" {
  description = "Environment name (dev, staging, production)"
  type        = string
  default     = "production"
}

variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
  default     = "flexi-day-be"
}

# VPC Configuration
variable "vpc_cidr" {
  description = "CIDR block for VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "List of availability zones (RDS requires subnets in at least 2 AZs)"
  type        = list(string)
  default     = ["eu-central-1a", "eu-central-1b"]
}

# RDS Configuration
variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t4g.micro"
}

variable "db_apply_immediately" {
  description = "Apply RDS modifications now instead of in the maintenance window. Pass with -var for one apply; the next apply without it shows a no-op change back to false."
  type        = bool
  default     = false
}

variable "db_allocated_storage" {
  description = "Allocated storage for RDS in GB"
  type        = number
  default     = 20
}

variable "db_name" {
  description = "Name of the default database"
  type        = string
  default     = "flexiday"
}

variable "db_username" {
  description = "Master username for RDS"
  type        = string
  default     = "postgres"
}

variable "db_port" {
  description = "Database port"
  type        = number
  default     = 5432
}

variable "db_backup_retention_period" {
  description = "Number of days to retain automated backups"
  type        = number
  default     = 7
}

variable "db_multi_az" {
  description = "Enable Multi-AZ deployment for RDS"
  type        = bool
  default     = false
}

# ECR Configuration
variable "ecr_repository_name" {
  description = "ECR repository name (existing repository, images pushed by GitHub Actions)"
  type        = string
  default     = "daniel88dev/flexi-day-be"
}

variable "docker_image_tag" {
  description = "ECR tag App Runner watches; every push to this tag auto-deploys ('main' on branch pushes, 'latest' on version tags)"
  type        = string
  default     = "main"
}

# App Runner Configuration
variable "app_port" {
  description = "Port the container listens on (Dockerfile default)"
  type        = number
  default     = 8080
}

variable "apprunner_cpu" {
  description = "vCPU per instance (256 = 0.25 vCPU)"
  type        = string
  default     = "256"
}

variable "apprunner_memory" {
  description = "Memory per instance in MB (512 = 0.5 GB)"
  type        = string
  default     = "512"
}

variable "apprunner_max_size" {
  description = "Maximum number of App Runner instances (cost cap)"
  type        = number
  default     = 2
}

# Domain Configuration
variable "hosted_zone_name" {
  description = "Route 53 public hosted zone name"
  type        = string
  default     = "flexi-day.com"
}

variable "api_domain_name" {
  description = "Fully-qualified domain for the API"
  type        = string
  default     = "api.flexi-day.com"
}

variable "email_from" {
  description = "Verified SES sender address for transactional email. Must be on the verified flexi-day.com domain."
  type        = string
  default     = "no-reply@flexi-day.com"
}

variable "manage_dns_validation_records" {
  description = "Set to true AFTER the first apply. The cert-validation records can only be created once the custom domain association exists (see dns.tf)."
  type        = bool
  default     = false
}

variable "trusted_origins" {
  description = "Origins allowed for Better Auth (TRUSTED_ORIGINS env), including the phone app's flexiday:// scheme; attachments.tf filters this to the http(s) entries for the bucket's CORS rule."
  type        = list(string)
  default     = ["https://flexi-day.com", "https://www.flexi-day.com", "flexiday://"]
}

# Developer DB access (IAM authentication)
variable "developer_iam_username" {
  description = "IAM user allowed to connect to the DB with IAM auth tokens"
  type        = string
  default     = "daniel-learning"
}

variable "db_iam_login" {
  description = "Postgres role name used for IAM-authenticated developer access"
  type        = string
  default     = "daniel"
}

# Better Auth Configuration
variable "better_auth_secret" {
  description = "Better Auth secret version 1, the key from before versioning; leave empty to use the generated one in state. Keep it set while version 1 is in use if it was ever set."
  type        = string
  sensitive   = true
  default     = ""
}

variable "better_auth_secret_version" {
  description = "Newest Better Auth secret version. Raising it by one rotates: it adds a version and drops the one before the previous. Signs out every active user once."
  type        = number
  default     = 1

  validation {
    condition     = var.better_auth_secret_version >= 1 && floor(var.better_auth_secret_version) == var.better_auth_secret_version
    error_message = "better_auth_secret_version must be a whole number of at least 1."
  }
}

variable "better_auth_rotation_days" {
  description = "Age (days) after which the plan warns that the newest Better Auth secret version is due for rotation."
  type        = number
  default     = 90
}

# Paddle Billing Configuration
#
# Billing is opt-in: leave paddle_api_key empty and no Paddle resources are
# created, no Paddle env vars are injected, and the backend's /api/billing/*
# routes return 503. Set it and the remaining Paddle variables become required
# — the backend refuses to boot with a half-configured Paddle block.
variable "paddle_api_key" {
  description = "Paddle API key (stored in Secrets Manager). Empty disables billing entirely."
  type        = string
  sensitive   = true
  default     = ""
}

variable "paddle_webhook_secret" {
  description = "Paddle webhook signing secret (stored in Secrets Manager). Required if paddle_api_key is set."
  type        = string
  sensitive   = true
  default     = ""
}

variable "paddle_environment" {
  description = "Paddle environment: 'sandbox' or 'production'. The backend refuses to boot on 'sandbox' when NODE_ENV=production."
  type        = string
  default     = "production"

  validation {
    condition     = contains(["sandbox", "production"], var.paddle_environment)
    error_message = "paddle_environment must be either \"sandbox\" or \"production\"."
  }
}

# Price IDs are NOT secrets — they identify catalog prices and are visible in
# any checkout — so they ride as plain env vars rather than Secrets Manager.
variable "paddle_prices" {
  description = "Paddle price IDs for the six EUR catalog prices. All required if paddle_api_key is set."
  type = object({
    pro_monthly         = string
    pro_yearly          = string
    enterprise_monthly  = string
    enterprise_yearly   = string
    extra_group_monthly = string
    extra_group_yearly  = string
  })
  default = {
    pro_monthly         = ""
    pro_yearly          = ""
    enterprise_monthly  = ""
    enterprise_yearly   = ""
    extra_group_monthly = ""
    extra_group_yearly  = ""
  }
}

# Google OAuth Configuration
variable "google_client_id" {
  description = "Google OAuth client ID (public; injected as a plain env var). Leave empty to disable Google sign-in."
  type        = string
  default     = ""
}

variable "google_client_secret" {
  description = "Google OAuth client secret (stored in Secrets Manager). Required if google_client_id is set."
  type        = string
  sensitive   = true
  default     = ""
}

# Microsoft Entra ID OAuth Configuration
variable "microsoft_client_id" {
  description = "Microsoft Entra ID application (client) ID (public; injected as a plain env var). Leave empty to disable Microsoft sign-in."
  type        = string
  default     = ""
}

variable "microsoft_client_secret" {
  description = "Microsoft Entra ID client secret VALUE (stored in Secrets Manager). Required if microsoft_client_id is set."
  type        = string
  sensitive   = true
  default     = ""
}

variable "microsoft_tenant_id" {
  description = "Directory to authenticate against: \"common\" (any work/school + personal account), \"organizations\", or a tenant GUID to allow a single directory."
  type        = string
  default     = "common"
}

# Sign in with Apple. The backend holds the .p8 key and mints the short-lived
# client secret itself, so there is no secret to rotate by hand; see
# docs/native-sign-in-setup.md in flexi-day-rn for the portal steps.
variable "apple_client_id" {
  description = "Apple Services ID identifier, the web flow's client_id (public; plain env var). Leave empty to disable Apple sign-in entirely."
  type        = string
  default     = ""
}

variable "apple_team_id" {
  description = "Apple Developer Team ID (public; plain env var). Required if apple_client_id is set."
  type        = string
  default     = ""
}

variable "apple_key_id" {
  description = "Key ID of the Sign in with Apple key, whose .p8 goes up through terraform/scripts/put-secret.sh apple (public; plain env var). Required if apple_client_id is set."
  type        = string
  default     = ""
}

variable "apple_app_bundle_identifier" {
  description = "iOS bundle id the phone's id tokens carry as their audience, and the APNs topic (public; plain env var). Required if apple_client_id or apns_key_id is set."
  type        = string
  default     = "com.flexiday.app"
}

variable "apns_key_id" {
  description = "Key ID of the APNs key, whose .p8 goes up through terraform/scripts/put-secret.sh apns (public; plain env var). Set it only once the key is uploaded; it wires APNS_* into App Runner. Leave empty to keep push off."
  type        = string
  default     = ""
}

# Calendar direct sync (docs/terraform.md has the rollout order)
variable "calendar_sync_google_enabled" {
  description = "Turns on Google Calendar direct sync (CALENDAR_SYNC_GOOGLE_ENABLED). Needs google_client_id and google_client_secret set. Until Google verifies the OAuth app for the calendar scope (T-302), every user sees the unverified-app warning and the app is capped at 100 users for life."
  type        = bool
  default     = false
}

variable "calendar_sync_microsoft_enabled" {
  description = "Turns on Microsoft calendar direct sync (CALENDAR_SYNC_MICROSOFT_ENABLED). Needs microsoft_client_id and microsoft_client_secret set. Keep false until Entra publisher verification is done (T-301); before it, users in other companies' tenants cannot consent to the calendar scopes."
  type        = bool
  default     = false
}

# AI features: the Assistant and AI connections (docs/terraform.md has the launch order)
variable "assistant_enabled" {
  description = "Kill switch for the Assistant (ASSISTANT_ENABLED). Off, its routes answer 404 and the web app hides it; data stays. Organizations in ai_preview_organization_ids get it either way."
  type        = bool
  default     = false
}

variable "ai_connections_enabled" {
  description = "Kill switch for AI connections (AI_CONNECTIONS_ENABLED): /mcp, its OAuth discovery and consent. Off, those answer 404 and the web app hides them; grants stay. Organizations in ai_preview_organization_ids get it either way."
  type        = bool
  default     = false
}

variable "ai_preview_organization_ids" {
  description = "Organization ids that get both AI features while a switch is off (AI_PREVIEW_ORGANIZATION_IDS). Starts with the operator's own organization."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for id in var.ai_preview_organization_ids :
      can(regex("^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$", id))
    ])
    error_message = "Each ai_preview_organization_ids entry must be an organization id (a UUID)."
  }
}

variable "assistant_driver" {
  description = "How the Assistant runs its sessions (ASSISTANT_DRIVER): managed (Claude Managed Agents) or fake (scripted, no Anthropic call). The backend refuses fake in production."
  type        = string
  default     = "managed"

  validation {
    condition     = contains(["managed", "fake"], var.assistant_driver)
    error_message = "assistant_driver must be \"managed\" or \"fake\"."
  }
}

variable "assistant_weekly_limit_usd" {
  description = "Each organization's Weekly limit on Assistant Usage in dollars (ASSISTANT_WEEKLY_LIMIT_USD), at Anthropic list price, reset Monday 00:00 UTC."
  type        = string
  default     = "10"

  validation {
    condition     = can(regex("^[0-9]+(\\.[0-9]{1,2})?$", var.assistant_weekly_limit_usd)) && try(tonumber(var.assistant_weekly_limit_usd) > 0, false)
    error_message = "assistant_weekly_limit_usd must be a positive dollar amount, such as \"10\" or \"12.50\"."
  }
}

variable "assistant_agent_id" {
  description = "Id of the flexi-day-assistant agent in the flexi-day-prod Anthropic workspace (ASSISTANT_AGENT_ID), printed by `pnpm run assistant:provision`. Public; plain env var. Required while the Assistant is on or the preview list is not empty."
  type        = string
  default     = ""

  validation {
    condition     = var.assistant_agent_id == "" || startswith(var.assistant_agent_id, "agent_")
    error_message = "assistant_agent_id must be an agent id (agent_...), as assistant:provision prints it."
  }
}

variable "assistant_environment_id" {
  description = "Id of the flexi-day-assistant environment in the flexi-day-prod Anthropic workspace (ASSISTANT_ENVIRONMENT_ID), printed by `pnpm run assistant:provision`. Public; plain env var. Required while the Assistant is on or the preview list is not empty."
  type        = string
  default     = ""

  validation {
    condition     = var.assistant_environment_id == "" || startswith(var.assistant_environment_id, "env_")
    error_message = "assistant_environment_id must be an environment id (env_...), as assistant:provision prints it."
  }
}

variable "kb_bundle_url" {
  description = "The help articles bundle the frontend publishes (KB_BUNDLE_URL), read by the Assistant's prompt and the docs tools on both channels. Always injected; the backend requires it in production while either AI feature is on."
  type        = string
  default     = "https://www.flexi-day.com/help/kb.json"

  validation {
    condition     = startswith(var.kb_bundle_url, "https://")
    error_message = "kb_bundle_url must be an https URL."
  }
}

variable "sentry_traces_mcp_rate" {
  description = "Sentry trace sample rate for /mcp (SENTRY_TRACES_MCP_RATE). Ignores the caller's trace headers, so an outside client can't raise it."
  type        = string
  default     = "0.05"

  validation {
    condition     = try(tonumber(var.sentry_traces_mcp_rate) >= 0 && tonumber(var.sentry_traces_mcp_rate) <= 1, false)
    error_message = "sentry_traces_mcp_rate must be a number from 0 to 1."
  }
}

variable "sentry_traces_assistant_rate" {
  description = "Sentry trace sample rate for the Assistant's chat API and its webhook (SENTRY_TRACES_ASSISTANT_RATE). 1 at launch; 0.2 once five organizations have the Assistant on (docs/terraform.md)."
  type        = string
  default     = "1"

  validation {
    condition     = try(tonumber(var.sentry_traces_assistant_rate) >= 0 && tonumber(var.sentry_traces_assistant_rate) <= 1, false)
    error_message = "sentry_traces_assistant_rate must be a number from 0 to 1."
  }
}

# Attachments (docs/adr/0003)
variable "attachments_bucket_name" {
  description = "S3 bucket for attachment bytes. Bucket names are global, so override on a collision; empty means <project_name>-<environment>-attachments."
  type        = string
  default     = ""
}

# Organization data (organization-data.tf)
variable "organization_data_bucket_name" {
  description = "S3 bucket for organization data (Profile photos, exports). Bucket names are global, so override on a collision; empty means flexi-day-prod-organization-data in production, flexi-day-<environment>-organization-data elsewhere."
  type        = string
  default     = ""
}

variable "github_actions_role_name" {
  description = "Name of the IAM role the backend's CD workflow assumes through GitHub OIDC (the role behind the AWS_ROLE_ARN repository variable). Created outside Terraform; this only attaches the policy that lets CD update the attachment-processor's code. Empty attaches nothing."
  type        = string
  default     = ""
}
