# Security Group for RDS Instance.
#
# Port 5432 is open to the internet: App Runner's default egress comes from
# changing AWS public IPs (no stable range to allowlist), and migrations are
# run manually from developer machines. The protections are the random
# 32-char master password, forced SSL (rds.force_ssl=1), and encrypted
# storage. If you later switch to a VPC connector + private DB, tighten this.
resource "aws_security_group" "rds" {
  name        = "${var.project_name}-${var.environment}-rds-sg"
  description = "RDS PostgreSQL - public endpoint, credential + TLS protected"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${var.project_name}-${var.environment}-rds-sg"
  }
}

resource "aws_vpc_security_group_ingress_rule" "rds_postgres" {
  security_group_id = aws_security_group.rds.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = var.db_port
  to_port           = var.db_port
  ip_protocol       = "tcp"
  description       = "PostgreSQL from anywhere (App Runner egress + manual migrations)"
}
