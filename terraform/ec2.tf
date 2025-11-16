# Data source for latest Amazon Linux 2023 AMI
data "aws_ami" "amazon_linux_2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# EC2 Instance
resource "aws_instance" "app" {
  ami           = data.aws_ami.amazon_linux_2023.id
  instance_type = var.ec2_instance_type
  subnet_id     = aws_subnet.public[0].id

  vpc_security_group_ids = [aws_security_group.ec2.id]
  iam_instance_profile   = aws_iam_instance_profile.ec2.name

  key_name = var.ec2_key_name != "" ? var.ec2_key_name : null

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.ec2_volume_size
    delete_on_termination = true
    encrypted             = true
  }

  user_data = base64encode(templatefile("${path.module}/user-data.sh", {
    aws_region          = var.aws_region
    ecr_repository_name = var.ecr_repository_name
    docker_image_tag    = var.docker_image_tag
    db_secret_name      = aws_secretsmanager_secret.db_credentials.name
    app_secret_name     = aws_secretsmanager_secret.app_config.name
    app_port            = var.app_port
    project_name        = var.project_name
    environment         = var.environment
  }))

  user_data_replace_on_change = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required" # IMDSv2 only
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-app-server"
  }

  depends_on = [
    aws_db_instance.main,
    aws_secretsmanager_secret_version.db_credentials,
    aws_secretsmanager_secret_version.app_config
  ]
}

# Elastic IP for EC2 instance (optional, for stable public IP)
resource "aws_eip" "app" {
  domain   = "vpc"
  instance = aws_instance.app.id

  tags = {
    Name = "${var.project_name}-${var.environment}-app-eip"
  }

  depends_on = [aws_internet_gateway.main]
}

# CloudWatch Log Group for application logs
resource "aws_cloudwatch_log_group" "app" {
  name              = "/aws/ec2/${var.project_name}-${var.environment}"
  retention_in_days = 7

  tags = {
    Name = "${var.project_name}-${var.environment}-app-logs"
  }
}