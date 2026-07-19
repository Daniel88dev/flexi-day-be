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
  description = "Better Auth secret; leave empty to auto-generate a random one"
  type        = string
  sensitive   = true
  default     = ""
}
