# Main Terraform configuration file
# Infrastructure resources are organized into separate files:
# - provider.tf: AWS provider configuration
# - variables.tf: Input variables
# - vpc.tf: VPC, public subnets, IGW, DB subnet group
# - security-groups.tf: RDS security group
# - iam.tf: App Runner ECR-access and instance roles
# - secrets.tf: Secrets Manager (DATABASE url, BETTER_AUTH_SECRET)
# - rds.tf: RDS PostgreSQL instance (public endpoint, manual migrations)
# - apprunner.tf: App Runner service (default egress), autoscaling
# - dns.tf: Route 53 records + custom domain association (api.flexi-day.com)
# - outputs.tf: Output values

# This file is intentionally left minimal to keep the configuration organized.
# All resources are defined in their respective domain-specific files.
