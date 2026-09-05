# Attachment storage and processing (docs/adr/0003). The browser uploads under
# a presigned POST to the incoming/ prefix of a private bucket; the S3 event
# invokes the attachment-processor Lambda, which checks the bytes, writes the
# result under the final key and reports to the API with a signed callback.
# The API presigns and deletes but never carries the bytes.

locals {
  attachments_bucket_name   = var.attachments_bucket_name != "" ? var.attachments_bucket_name : "${var.project_name}-${var.environment}-attachments"
  attachment_processor_name = "${var.project_name}-${var.environment}-attachment-processor"
}

# --- Bucket ------------------------------------------------------------------

resource "aws_s3_bucket" "attachments" {
  bucket = local.attachments_bucket_name

  tags = {
    Name = local.attachments_bucket_name
  }
}

resource "aws_s3_bucket_public_access_block" "attachments" {
  bucket                  = aws_s3_bucket.attachments.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "attachments" {
  bucket = aws_s3_bucket.attachments.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "attachments" {
  bucket = aws_s3_bucket.attachments.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# The API's nightly sweep is what deletes attachments (CONTEXT.md, Quota
# rollover). These rules are the backstop: an upload the Lambda never got to
# leaves incoming/ within a day, and nothing outlives the twelve-month
# retention by more than two months even if the sweep stops running.
resource "aws_s3_bucket_lifecycle_configuration" "attachments" {
  bucket = aws_s3_bucket.attachments.id

  rule {
    id     = "incoming-expires"
    status = "Enabled"

    filter {
      prefix = "incoming/"
    }

    expiration {
      days = 1
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  rule {
    id     = "retention-backstop"
    status = "Enabled"

    filter {}

    expiration {
      days = 425
    }
  }
}

# The presigned POST is a cross-origin form post from the frontend; the
# presigned GET is opened or fetched from there too.
resource "aws_s3_bucket_cors_configuration" "attachments" {
  bucket = aws_s3_bucket.attachments.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "POST"]
    allowed_origins = var.trusted_origins
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

# --- Lambda ------------------------------------------------------------------

# Terraform creates the function with this stub and then ignores its code:
# cd.yml ships the real handler with `aws lambda update-function-code` on
# every push to main (see the deploy-attachment-processor job).
data "archive_file" "attachment_processor_placeholder" {
  type        = "zip"
  output_path = "${path.module}/.terraform/attachment-processor-placeholder.zip"

  source {
    filename = "index.mjs"
    content  = "export const handler = async () => { throw new Error(\"attachment-processor: CD has not deployed the code yet\"); };"
  }
}

resource "aws_cloudwatch_log_group" "attachment_processor" {
  name              = "/aws/lambda/${local.attachment_processor_name}"
  retention_in_days = 14

  tags = {
    Name = local.attachment_processor_name
  }
}

resource "aws_iam_role" "attachment_processor" {
  name = local.attachment_processor_name

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name = local.attachment_processor_name
  }
}

# Read and delete what the browser uploaded, write the checked result, read
# the callback secret, and log. Final keys have no fixed prefix (they start
# with the organization id), so PutObject covers the bucket minus incoming/,
# which only the browser's presigned POST may write.
resource "aws_iam_role_policy" "attachment_processor" {
  name = local.attachment_processor_name
  role = aws_iam_role.attachment_processor.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.attachments.arn}/incoming/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.attachments.arn}/*"
      },
      {
        Effect   = "Deny"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.attachments.arn}/incoming/*"
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_secretsmanager_secret.attachments_callback_secret.arn
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.attachment_processor.arn}:*"
      }
    ]
  })
}

resource "aws_lambda_function" "attachment_processor" {
  function_name = local.attachment_processor_name
  description   = "Checks uploaded attachments, rewrites images, reports to the API (docs/adr/0003)"
  role          = aws_iam_role.attachment_processor.arn
  runtime       = "nodejs24.x"
  handler       = "index.handler"
  architectures = ["x86_64"]

  filename         = data.archive_file.attachment_processor_placeholder.output_path
  source_code_hash = data.archive_file.attachment_processor_placeholder.output_base64sha256

  # A 10 MB HEIC decodes through WebAssembly into a 160 MB RGBA bitmap before
  # sharp sees it; the headroom costs nothing at this invocation volume.
  memory_size = 1536
  timeout     = 60

  environment {
    variables = {
      ATTACHMENTS_BUCKET              = aws_s3_bucket.attachments.bucket
      ATTACHMENTS_CALLBACK_SECRET_ARN = aws_secretsmanager_secret.attachments_callback_secret.arn
      API_URL                         = "https://${var.api_domain_name}"
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.attachment_processor,
    aws_iam_role_policy.attachment_processor
  ]

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }

  tags = {
    Name = local.attachment_processor_name
  }
}

resource "aws_lambda_permission" "attachments_bucket" {
  statement_id   = "AllowAttachmentsBucketInvoke"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.attachment_processor.function_name
  principal      = "s3.amazonaws.com"
  source_arn     = aws_s3_bucket.attachments.arn
  source_account = data.aws_caller_identity.current.account_id
}

resource "aws_s3_bucket_notification" "attachments" {
  bucket = aws_s3_bucket.attachments.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.attachment_processor.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "incoming/"
  }

  depends_on = [aws_lambda_permission.attachments_bucket]
}

# --- CD ------------------------------------------------------------------------

# The CD role predates Terraform, so only the policy is managed here. GetFunction
# is what `aws lambda wait function-updated` polls.
resource "aws_iam_role_policy" "github_actions_attachment_processor" {
  count = var.github_actions_role_name != "" ? 1 : 0
  name  = "${local.attachment_processor_name}-deploy"
  role  = var.github_actions_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["lambda:UpdateFunctionCode", "lambda:GetFunction"]
        Resource = aws_lambda_function.attachment_processor.arn
      }
    ]
  })
}
