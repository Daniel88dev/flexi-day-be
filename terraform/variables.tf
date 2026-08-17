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
  default     = "db.t3.micro"
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
  description = "Frontend origins allowed for CORS / Better Auth (TRUSTED_ORIGINS env)"
  type        = list(string)
  default     = ["https://flexi-day.com", "https://www.flexi-day.com"]
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
  description = "Better Auth secret; leave empty to auto-generate a rotating one (see better_auth_rotation_days)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "better_auth_rotation_days" {
  description = "Rotation window (days) for the auto-generated Better Auth secret. Only applies when better_auth_secret is empty. Advancing the window signs out all users once."
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
