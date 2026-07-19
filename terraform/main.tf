# Main Terraform configuration file
# Infrastructure resources are organized into separate files:
# - provider.tf: AWS provider configuration
# - variables.tf: Input variables
# - vpc.tf: VPC, private subnets, DB subnet group (no internet access)
# - security-groups.tf: App Runner connector SG and RDS SG
# - iam.tf: App Runner ECR-access and instance roles
# - secrets.tf: Secrets Manager (DATABASE url, BETTER_AUTH_SECRET)
# - rds.tf: RDS PostgreSQL instance (private)
# - apprunner.tf: App Runner service, VPC connector, autoscaling
# - dns.tf: Route 53 records + custom domain association (api.flexi-day.com)
# - outputs.tf: Output values

# This file is intentionally left minimal to keep the configuration organized.
# All resources are defined in their respective domain-specific files.
