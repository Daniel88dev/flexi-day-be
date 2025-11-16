#!/bin/bash
set -e

# Log all output to a file for debugging
exec > >(tee /var/log/user-data.log)
exec 2>&1

echo "Starting user data script execution..."

# Update system packages
echo "Updating system packages..."
dnf update -y

# Install Docker
echo "Installing Docker..."
dnf install -y docker
systemctl start docker
systemctl enable docker

# Install AWS CLI v2 (if not already installed)
echo "Installing AWS CLI v2..."
if ! command -v aws &> /dev/null; then
    curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
    dnf install -y unzip
    unzip awscliv2.zip
    ./aws/install
    rm -rf aws awscliv2.zip
fi

# Install CloudWatch Logs agent
echo "Installing CloudWatch Logs agent..."
dnf install -y amazon-cloudwatch-agent

# Configure CloudWatch Logs agent
cat > /opt/aws/amazon-cloudwatch-agent/etc/config.json <<EOF
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/user-data.log",
            "log_group_name": "/aws/ec2/${project_name}-${environment}",
            "log_stream_name": "{instance_id}/user-data.log"
          },
          {
            "file_path": "/var/log/app.log",
            "log_group_name": "/aws/ec2/${project_name}-${environment}",
            "log_stream_name": "{instance_id}/app.log"
          }
        ]
      }
    }
  }
}
EOF

# Start CloudWatch Logs agent
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
    -a fetch-config \
    -m ec2 \
    -s \
    -c file:/opt/aws/amazon-cloudwatch-agent/etc/config.json

# Get AWS account ID
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Authenticate Docker with ECR
echo "Authenticating with ECR..."
aws ecr get-login-password --region ${aws_region} | \
    docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.${aws_region}.amazonaws.com

# Pull Docker image from ECR
echo "Pulling Docker image from ECR..."
DOCKER_IMAGE="$AWS_ACCOUNT_ID.dkr.ecr.${aws_region}.amazonaws.com/${ecr_repository_name}:${docker_image_tag}"
docker pull $DOCKER_IMAGE

# Fetch database credentials from Secrets Manager
echo "Fetching database credentials from Secrets Manager..."
DB_SECRET=$(aws secretsmanager get-secret-value \
    --secret-id ${db_secret_name} \
    --region ${aws_region} \
    --query SecretString \
    --output text)

# Extract DATABASE connection string from secret
DATABASE=$(echo $DB_SECRET | jq -r '.connection_string')

# Fetch application configuration from Secrets Manager
echo "Fetching application configuration from Secrets Manager..."
APP_SECRET=$(aws secretsmanager get-secret-value \
    --secret-id ${app_secret_name} \
    --region ${aws_region} \
    --query SecretString \
    --output text)

# Extract app config values
BETTER_AUTH_SECRET=$(echo $APP_SECRET | jq -r '.BETTER_AUTH_SECRET')
BETTER_AUTH_URL=$(echo $APP_SECRET | jq -r '.BETTER_AUTH_URL')
NODE_ENV=$(echo $APP_SECRET | jq -r '.NODE_ENV')

# Create environment file for Docker
cat > /etc/flexi-day-env <<EOF
NODE_ENV=$NODE_ENV
PORT=${app_port}
DATABASE=$DATABASE
BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET
BETTER_AUTH_URL=$BETTER_AUTH_URL
EOF

# Generate database migrations (in case migration files are not in the image)
echo "Generating database migrations..."
docker run --rm \
    --env-file /etc/flexi-day-env \
    $DOCKER_IMAGE \
    npm run db:generate || echo "Migration generation skipped or failed (may already exist)"

# Run database migrations
echo "Running database migrations..."
docker run --rm \
    --env-file /etc/flexi-day-env \
    $DOCKER_IMAGE \
    npm run db:migrate

# Create systemd service for the application
cat > /etc/systemd/system/flexi-day.service <<EOF
[Unit]
Description=Flexi Day Backend Application
After=docker.service
Requires=docker.service

[Service]
Type=simple
Restart=always
RestartSec=10
User=root
ExecStartPre=-/usr/bin/docker stop flexi-day-app
ExecStartPre=-/usr/bin/docker rm flexi-day-app
ExecStart=/usr/bin/docker run --rm \\
    --name flexi-day-app \\
    --env-file /etc/flexi-day-env \\
    -p ${app_port}:${app_port} \\
    -p 80:${app_port} \\
    $DOCKER_IMAGE
ExecStop=/usr/bin/docker stop flexi-day-app

# Logging
StandardOutput=append:/var/log/app.log
StandardError=append:/var/log/app.log

[Install]
WantedBy=multi-user.target
EOF

# Set proper permissions on the env file
chmod 600 /etc/flexi-day-env

# Enable and start the application service
echo "Starting the application service..."
systemctl daemon-reload
systemctl enable flexi-day.service
systemctl start flexi-day.service

# Wait for the application to start
sleep 10

# Check if the application is running
if systemctl is-active --quiet flexi-day.service; then
    echo "Application started successfully!"
    systemctl status flexi-day.service
else
    echo "Failed to start application!"
    journalctl -u flexi-day.service --no-pager
    exit 1
fi

echo "User data script completed successfully!"