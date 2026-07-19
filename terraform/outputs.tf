# API endpoints
output "api_url" {
  description = "Public API URL on the custom domain"
  value       = "https://${var.api_domain_name}"
}

output "apprunner_service_url" {
  description = "Default App Runner URL (works even before DNS/cert are ready)"
  value       = "https://${aws_apprunner_service.main.service_url}"
}

output "apprunner_service_arn" {
  description = "App Runner service ARN"
  value       = aws_apprunner_service.main.arn
}

output "custom_domain_status" {
  description = "Status of the custom domain association (wait for 'active')"
  value       = aws_apprunner_custom_domain_association.api.status
}

# Redeploy helper (only needed if you ever disable auto-deployments)
output "manual_redeploy_command" {
  description = "CLI command to force a redeploy of the current image tag"
  value       = "aws apprunner start-deployment --service-arn ${aws_apprunner_service.main.arn} --region ${var.aws_region}"
}

# VPC
output "vpc_id" {
  description = "ID of the VPC"
  value       = aws_vpc.main.id
}

output "public_subnet_ids" {
  description = "IDs of public subnets"
  value       = aws_subnet.public[*].id
}

# RDS
output "rds_endpoint" {
  description = "RDS instance endpoint (publicly reachable, TLS + password protected)"
  value       = aws_db_instance.main.endpoint
}

output "rds_database_name" {
  description = "Name of the default database"
  value       = aws_db_instance.main.db_name
}

# Secrets
output "database_url_secret_arn" {
  description = "ARN of the DATABASE connection-string secret"
  value       = aws_secretsmanager_secret.database_url.arn
}

output "better_auth_secret_arn" {
  description = "ARN of the BETTER_AUTH_SECRET secret"
  value       = aws_secretsmanager_secret.better_auth_secret.arn
}

output "get_database_url_command" {
  description = "CLI command to read the DB connection string (for debugging)"
  value       = "aws secretsmanager get-secret-value --secret-id ${aws_secretsmanager_secret.database_url.name} --region ${var.aws_region} --query SecretString --output text"
}

# Security groups
output "rds_security_group_id" {
  description = "SG protecting RDS"
  value       = aws_security_group.rds.id
}

# Manual migration helper: run from the repo root on your machine.
# sslmode=no-verify -> encrypted connection without needing the RDS CA
# bundle installed locally (the app itself does full verification).
output "manual_migration_command" {
  description = "Command to run drizzle migrations from your machine"
  value       = "DATABASE=\"$(aws secretsmanager get-secret-value --secret-id ${aws_secretsmanager_secret.database_url.name} --region ${var.aws_region} --query SecretString --output text)?sslmode=no-verify\" npm run db:migrate"
}
