# RDS PostgreSQL Instance
resource "aws_db_instance" "main" {
  identifier = "${var.project_name}-${var.environment}-db"

  # Engine Configuration
  engine                = "postgres"
  engine_version        = "17.7"
  instance_class        = var.db_instance_class
  allocated_storage     = var.db_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  max_allocated_storage = var.db_allocated_storage * 2 # Enable autoscaling up to 2x

  # Database Configuration
  db_name  = var.db_name
  username = var.db_username
  password = random_password.db_password.result
  port     = var.db_port

  # Network Configuration
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = true

  # High Availability
  multi_az = var.db_multi_az

  # Backup Configuration
  backup_retention_period   = var.db_backup_retention_period
  backup_window             = "03:00-04:00"
  maintenance_window        = "mon:04:00-mon:05:00"
  skip_final_snapshot       = var.environment != "production"
  final_snapshot_identifier = var.environment == "production" ? "${var.project_name}-${var.environment}-final-snapshot-${formatdate("YYYY-MM-DD-hhmm", timestamp())}" : null

  # Performance Insights
  performance_insights_enabled          = true
  performance_insights_retention_period = 7

  # Monitoring
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  monitoring_interval             = 60
  monitoring_role_arn             = aws_iam_role.rds_monitoring.arn

  # IAM Database Authentication
  iam_database_authentication_enabled = true

  # Parameter and Option Groups
  parameter_group_name = aws_db_parameter_group.main.name

  # Enable auto minor version upgrade
  auto_minor_version_upgrade = true

  # Deletion protection for production
  deletion_protection = var.environment == "production"

  # Copy tags to snapshots
  copy_tags_to_snapshot = true

  tags = {
    Name = "${var.project_name}-${var.environment}-db"
  }

  depends_on = [
    aws_db_subnet_group.main,
    aws_security_group.rds
  ]
}

# DB Parameter Group for PostgreSQL
# Using minimal configuration to avoid issues with static vs dynamic parameters
resource "aws_db_parameter_group" "main" {
  name   = "${var.project_name}-${var.environment}-pg-params"
  family = "postgres17"

  description = "Parameter group for flexi-day-be PostgreSQL database"

  # Only including dynamic parameters that can be changed without restart
  # You can add more parameters later via AWS Console if needed

  parameter {
    name         = "log_min_duration_statement"
    value        = "1000" # Log queries taking more than 1 second
    apply_method = "immediate"
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-pg-params"
  }
}

# IAM Role for RDS Enhanced Monitoring
resource "aws_iam_role" "rds_monitoring" {
  name = "${var.project_name}-${var.environment}-rds-monitoring-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "monitoring.rds.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name = "${var.project_name}-${var.environment}-rds-monitoring-role"
  }
}

# Attach AWS managed policy for RDS Enhanced Monitoring
resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

# CloudWatch Log Group for PostgreSQL logs
resource "aws_cloudwatch_log_group" "postgresql" {
  name              = "/aws/rds/instance/${var.project_name}-${var.environment}-db/postgresql"
  retention_in_days = 7

  tags = {
    Name = "${var.project_name}-${var.environment}-db-postgresql-logs"
  }
}

resource "aws_cloudwatch_log_group" "postgresql_upgrade" {
  name              = "/aws/rds/instance/${var.project_name}-${var.environment}-db/upgrade"
  retention_in_days = 7

  tags = {
    Name = "${var.project_name}-${var.environment}-db-upgrade-logs"
  }
}