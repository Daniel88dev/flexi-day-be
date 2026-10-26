# Organization data: Profile photos under photos/, Person and Organization exports under
# exports/, and later per-person documents. One customer managed KMS key
# encrypts the bucket and wraps each organization's data key for the Sensitive
# section fields. docs/terraform.md has the reasoning behind every rule here.

locals {
  organization_data_bucket_name = var.organization_data_bucket_name != "" ? var.organization_data_bucket_name : "flexi-day-${var.environment == "production" ? "prod" : var.environment}-organization-data"
  organization_data_name        = "${var.project_name}-${var.environment}-organization-data"
  account_root_arn              = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
}

# --- KMS key -------------------------------------------------------------------

# Losing this key loses every encrypted Contact and Personal field and every
# object in the bucket, with no way back. prevent_destroy stops Terraform, the
# 30-day window leaves time to cancel a deletion, and the policy lets only the
# root user schedule one.
resource "aws_kms_key" "organization_data" {
  description             = "Organization data: the ${local.organization_data_bucket_name} bucket and the per-organization data keys"
  enable_key_rotation     = true
  rotation_period_in_days = 365
  deletion_window_in_days = 30

  # The first statement is AWS's default, which hands the key to IAM, so the
  # App Runner role and whoever runs Terraform keep working through IAM
  # policies. The deny overrides any IAM allow, AdministratorAccess included.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountThroughIam"
        Effect    = "Allow"
        Principal = { AWS = local.account_root_arn }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "OnlyRootSchedulesDeletion"
        Effect    = "Deny"
        Principal = { AWS = "*" }
        Action    = "kms:ScheduleKeyDeletion"
        Resource  = "*"
        Condition = {
          StringNotEquals = { "aws:PrincipalArn" = local.account_root_arn }
        }
      }
    ]
  })

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name = local.organization_data_name
  }
}

resource "aws_kms_alias" "organization_data" {
  name          = "alias/${local.organization_data_name}"
  target_key_id = aws_kms_key.organization_data.key_id
}

# --- Bucket ------------------------------------------------------------------

resource "aws_s3_bucket" "organization_data" {
  bucket = local.organization_data_bucket_name

  tags = {
    Name = local.organization_data_bucket_name
  }
}

resource "aws_s3_bucket_public_access_block" "organization_data" {
  bucket                  = aws_s3_bucket.organization_data.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "organization_data" {
  bucket = aws_s3_bucket.organization_data.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "organization_data" {
  bucket = aws_s3_bucket.organization_data.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "organization_data" {
  bucket = aws_s3_bucket.organization_data.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.organization_data.arn
    }
    bucket_key_enabled = true
  }
}

# No age-based expiry: a Retention purge or an Erase deletes an object, and the
# old version it leaves goes 7 days later, matching the RDS backup window.
resource "aws_s3_bucket_lifecycle_configuration" "organization_data" {
  bucket = aws_s3_bucket.organization_data.id

  rule {
    id     = "old-versions-expire"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 7
    }

    expiration {
      expired_object_delete_marker = true
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  rule {
    id     = "incoming-expires"
    status = "Enabled"

    filter {
      prefix = "incoming/"
    }

    expiration {
      days = 1
    }
  }

  rule {
    id     = "exports-expire"
    status = "Enabled"

    filter {
      prefix = "exports/"
    }

    expiration {
      days = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.organization_data]
}

# The same browser-origins rule as the attachments bucket, for the same reason.
resource "aws_s3_bucket_cors_configuration" "organization_data" {
  bucket = aws_s3_bucket.organization_data.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "POST"]
    allowed_origins = [for origin in var.trusted_origins : origin if can(regex("^https?://", origin))]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

# --- Profile photos: the attachment-processor's second trigger ----------------

# The browser posts a Profile photo to incoming/ under a presigned POST the API
# issues; this event hands it to the same Lambda as attachments, which tells
# the two apart by the event's bucket (docs/adr/0003).
resource "aws_lambda_permission" "organization_data_bucket" {
  statement_id   = "AllowOrganizationDataBucketInvoke"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.attachment_processor.function_name
  principal      = "s3.amazonaws.com"
  source_arn     = aws_s3_bucket.organization_data.arn
  source_account = data.aws_caller_identity.current.account_id
}

resource "aws_s3_bucket_notification" "organization_data" {
  bucket = aws_s3_bucket.organization_data.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.attachment_processor.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "incoming/"
  }

  depends_on = [aws_lambda_permission.organization_data_bucket]
}

# Read the upload, write both sizes under photos/, delete either (the incoming
# object once handled, the sizes when the API reports the photo gone), list so
# a missing key reads as NoSuchKey. exports/ stays out of reach.
#
# The bucket is SSE-KMS under the key that also wraps every organization's
# data key. The KMS rights hold only while S3 asks on the Lambda's behalf for
# this bucket: with S3 Bucket Keys the encryption context is the bucket ARN,
# and field encryption's context carries no aws:s3:arn at all, so the Lambda
# can never unwrap a data key.
resource "aws_iam_role_policy" "attachment_processor_organization_data" {
  name = "${local.attachment_processor_name}-organization-data"
  role = aws_iam_role.attachment_processor.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.organization_data.arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.organization_data.arn}/incoming/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.organization_data.arn}/photos/*"
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = aws_kms_key.organization_data.arn
        Condition = {
          StringEquals = {
            "kms:EncryptionContext:aws:s3:arn" = aws_s3_bucket.organization_data.arn
            "kms:ViaService"                   = "s3.${var.aws_region}.amazonaws.com"
          }
        }
      }
    ]
  })
}
