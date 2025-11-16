# VPC Outputs
output "vpc_id" {
  description = "ID of the VPC"
  value       = aws_vpc.main.id
}

output "vpc_cidr" {
  description = "CIDR block of the VPC"
  value       = aws_vpc.main.cidr_block
}

# Subnet Outputs
output "public_subnet_ids" {
  description = "IDs of public subnets"
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "IDs of private subnets"
  value       = aws_subnet.private[*].id
}

# EC2 Outputs
output "ec2_instance_id" {
  description = "ID of the EC2 instance"
  value       = aws_instance.app.id
}

output "ec2_public_ip" {
  description = "Public IP address of the EC2 instance (Elastic IP)"
  value       = aws_eip.app.public_ip
}

output "ec2_private_ip" {
  description = "Private IP address of the EC2 instance"
  value       = aws_instance.app.private_ip
}

output "application_url" {
  description = "URL to access the application"
  value       = "http://${aws_eip.app.public_ip}:${var.app_port}"
}

output "application_url_http" {
  description = "HTTP URL (port 80) to access the application"
  value       = "http://${aws_eip.app.public_ip}"
}

# RDS Outputs
output "rds_endpoint" {
  description = "RDS instance endpoint"
  value       = aws_db_instance.main.endpoint
}

output "rds_address" {
  description = "RDS instance address"
  value       = aws_db_instance.main.address
}

output "rds_port" {
  description = "RDS instance port"
  value       = aws_db_instance.main.port
}

output "rds_database_name" {
  description = "Name of the default database"
  value       = aws_db_instance.main.db_name
}

output "rds_resource_id" {
  description = "RDS resource ID (for IAM authentication)"
  value       = aws_db_instance.main.resource_id
}

# Secrets Manager Outputs
output "db_credentials_secret_arn" {
  description = "ARN of the database credentials secret"
  value       = aws_secretsmanager_secret.db_credentials.arn
}

output "db_credentials_secret_name" {
  description = "Name of the database credentials secret"
  value       = aws_secretsmanager_secret.db_credentials.name
}

output "app_config_secret_arn" {
  description = "ARN of the application configuration secret"
  value       = aws_secretsmanager_secret.app_config.arn
}

output "app_config_secret_name" {
  description = "Name of the application configuration secret"
  value       = aws_secretsmanager_secret.app_config.name
}

# Security Group Outputs
output "ec2_security_group_id" {
  description = "ID of the EC2 security group"
  value       = aws_security_group.ec2.id
}

output "rds_security_group_id" {
  description = "ID of the RDS security group"
  value       = aws_security_group.rds.id
}

# IAM Outputs
output "ec2_iam_role_arn" {
  description = "ARN of the EC2 IAM role"
  value       = aws_iam_role.ec2.arn
}

output "ec2_instance_profile_name" {
  description = "Name of the EC2 instance profile"
  value       = aws_iam_instance_profile.ec2.name
}

# Connection Instructions
output "ssh_connection_command" {
  description = "SSH command to connect to the EC2 instance"
  value       = var.ec2_key_name != "" ? "ssh -i /path/to/${var.ec2_key_name}.pem ec2-user@${aws_eip.app.public_ip}" : "Use AWS Systems Manager Session Manager to connect (no SSH key configured)"
}

output "ssm_connection_command" {
  description = "AWS Systems Manager Session Manager connection command"
  value       = "aws ssm start-session --target ${aws_instance.app.id} --region ${var.aws_region}"
}

output "get_db_credentials_command" {
  description = "AWS CLI command to retrieve database credentials"
  value       = "aws secretsmanager get-secret-value --secret-id ${aws_secretsmanager_secret.db_credentials.name} --region ${var.aws_region} --query SecretString --output text | jq ."
}

output "get_app_config_command" {
  description = "AWS CLI command to retrieve application configuration"
  value       = "aws secretsmanager get-secret-value --secret-id ${aws_secretsmanager_secret.app_config.name} --region ${var.aws_region} --query SecretString --output text | jq ."
}

# ECR Information
output "ecr_repository_url" {
  description = "ECR repository URL for Docker image (existing repository)"
  value       = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/${var.ecr_repository_name}"
}

output "ecr_full_image_uri" {
  description = "Full ECR image URI with tag"
  value       = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/${var.ecr_repository_name}:${var.docker_image_tag}"
}

output "docker_login_command" {
  description = "Command to authenticate Docker with ECR"
  value       = "aws ecr get-login-password --region ${var.aws_region} | docker login --username AWS --password-stdin ${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com"
}