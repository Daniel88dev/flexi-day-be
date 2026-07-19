# Custom domain: api.flexi-day.com -> App Runner service.
#
# App Runner provisions and renews the TLS certificate itself; we only have
# to publish its certificate-validation CNAME records plus the domain CNAME
# in Route 53.
#
# TWO-STEP FIRST ROLLOUT: the validation records are unknown until the
# domain association exists, and Terraform cannot for_each over unknown
# values. So:
#   1. terraform apply                                  (flag is false)
#   2. set manage_dns_validation_records = true in terraform.tfvars
#   3. terraform apply                                  (creates the records)
# Every apply after that is a normal single "terraform apply".

data "aws_route53_zone" "main" {
  name         = var.hosted_zone_name
  private_zone = false
}

resource "aws_apprunner_custom_domain_association" "api" {
  domain_name          = var.api_domain_name
  service_arn          = aws_apprunner_service.main.arn
  enable_www_subdomain = false
}

# Certificate validation records (keep them: they are also used for renewal)
resource "aws_route53_record" "api_cert_validation" {
  for_each = var.manage_dns_validation_records ? {
    for record in aws_apprunner_custom_domain_association.api.certificate_validation_records :
    record.name => record
  } : {}

  zone_id = data.aws_route53_zone.main.zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 300
  records = [each.value.value]
}

# The actual api.flexi-day.com -> <service>.awsapprunner.com record
resource "aws_route53_record" "api" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = var.api_domain_name
  type    = "CNAME"
  ttl     = 300
  records = [aws_apprunner_custom_domain_association.api.dns_target]
}
