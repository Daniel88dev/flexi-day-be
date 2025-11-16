# Main Terraform configuration file
# Infrastructure resources are organized into separate files:
# - provider.tf: AWS provider configuration
# - variables.tf: Input variables
# - vpc.tf: VPC, subnets, and networking
# - security-groups.tf: Security groups for EC2 and RDS
# - iam.tf: IAM roles and policies
# - secrets.tf: AWS Secrets Manager configuration
# - rds.tf: RDS PostgreSQL instance
# - ec2.tf: EC2 instance for application
# - outputs.tf: Output values

# This file is intentionally left minimal to keep the configuration organized.
# All resources are defined in their respective domain-specific files.