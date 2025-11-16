# General Configuration
variable "aws_region" {
  description = "AWS region for resources"
  type        = string
  default     = "eu-central-1"
}

variable "environment" {
  description = "Environment name (dev, staging, production)"
  type        = string
  default     = "dev"
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

# EC2 Configuration
variable "ec2_instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.micro"
}

variable "ec2_key_name" {
  description = "EC2 key pair name for SSH access"
  type        = string
  default     = ""
}

variable "ec2_volume_size" {
  description = "Root volume size in GB"
  type        = number
  default     = 30
}

# ECR Configuration
variable "ecr_repository_name" {
  description = "ECR repository name (existing repository created via GitHub Actions)"
  type        = string
  default     = "daniel88dev/flexi-day-be"
}

variable "docker_image_tag" {
  description = "Docker image tag to deploy"
  type        = string
  default     = "latest"
}

# Application Configuration
variable "app_port" {
  description = "Application port"
  type        = number
  default     = 3000
}

variable "allowed_cidr_blocks" {
  description = "CIDR blocks allowed to access the application"
  type        = list(string)
  default     = ["0.0.0.0/0"] # Change this to your specific IP ranges for production
}

# Better Auth Configuration
variable "better_auth_secret" {
  description = "Better Auth secret key"
  type        = string
  sensitive   = true
  default     = ""
}

variable "better_auth_url" {
  description = "Better Auth URL (e.g., https://yourdomain.com)"
  type        = string
  default     = ""
}