# Security Group for the App Runner VPC connector.
# App Runner attaches this SG to the ENIs it creates in the private subnets,
# so all traffic the app sends into the VPC carries this SG as its source.
resource "aws_security_group" "app" {
  name        = "${var.project_name}-${var.environment}-app-sg"
  description = "App Runner VPC connector - application egress into the VPC"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${var.project_name}-${var.environment}-app-sg"
  }
}

# Security Group for RDS Instance
resource "aws_security_group" "rds" {
  name        = "${var.project_name}-${var.environment}-rds-sg"
  description = "RDS PostgreSQL - only reachable from the app SG"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${var.project_name}-${var.environment}-rds-sg"
  }
}

# Rules are separate resources (not inline) because the two SGs reference
# each other, which would otherwise be a dependency cycle.

# App -> RDS (only egress the app needs inside the VPC)
resource "aws_vpc_security_group_egress_rule" "app_to_rds" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.rds.id
  from_port                    = var.db_port
  to_port                      = var.db_port
  ip_protocol                  = "tcp"
  description                  = "PostgreSQL to RDS"
}

# RDS <- App
resource "aws_vpc_security_group_ingress_rule" "rds_from_app" {
  security_group_id            = aws_security_group.rds.id
  referenced_security_group_id = aws_security_group.app.id
  from_port                    = var.db_port
  to_port                      = var.db_port
  ip_protocol                  = "tcp"
  description                  = "PostgreSQL from App Runner"
}
