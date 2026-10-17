#!/usr/bin/env bash
#
# Upload an Apple .p8 key from 1Password into its Secrets Manager slot.
#
#   terraform/scripts/put-p8.sh apple              Sign in with Apple key
#   terraform/scripts/put-p8.sh apns               APNs key
#   terraform/scripts/put-p8.sh apple --redeploy   also start an App Runner deployment
#
# Terraform owns the slots and never the keys (docs/terraform.md). The key is
# read by item title from the Development vault and piped straight into
# put-secret-value, so it never appears in argv, shell history or the terminal.
# App Runner reads a secret only at deployment: a new key id in terraform.tfvars
# redeploys on the next apply, and --redeploy covers re-uploading the same key.
#
# P8_SECRET_PREFIX (default flexi-day-be-production) is <project>-<environment>,
# naming both the slots and the App Runner service. AWS_REGION defaults to
# eu-central-1.

set -euo pipefail
# bash -x would print the key.
set +x

die() {
  echo "put-p8: $*" >&2
  exit 1
}

usage() {
  echo "usage: $0 apple|apns [--redeploy]" >&2
  exit 2
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is not installed"
}

KIND="${1:-}"
shift || true

REDEPLOY=0
for arg in "$@"; do
  case "$arg" in
    --redeploy) REDEPLOY=1 ;;
    *) usage ;;
  esac
done

: "${P8_SECRET_PREFIX:=flexi-day-be-production}"
: "${AWS_REGION:=eu-central-1}"
VAULT="Development"

case "$KIND" in
  apple)
    ITEM="Flexi Day Sign in with Apple key"
    SECRET_ID="$P8_SECRET_PREFIX-apple-private-key"
    KEY_ID_VAR="apple_key_id"
    ;;
  apns)
    ITEM="Flexi Day APNs key"
    SECRET_ID="$P8_SECRET_PREFIX-apns-private-key"
    KEY_ID_VAR="apns_key_id"
    ;;
  *) usage ;;
esac

need op
need aws

aws secretsmanager describe-secret \
  --secret-id "$SECRET_ID" \
  --region "$AWS_REGION" >/dev/null ||
  die "no secret $SECRET_ID; run terraform apply first so it exists"

key="$(op document get "$ITEM" --vault "$VAULT")" ||
  die "could not read \"$ITEM\" from the $VAULT vault"

[[ "$key" == "-----BEGIN PRIVATE KEY-----"* ]] ||
  die "\"$ITEM\" is not a PEM private key; nothing uploaded"

version="$(printf '%s' "$key" | aws secretsmanager put-secret-value \
  --secret-id "$SECRET_ID" \
  --region "$AWS_REGION" \
  --secret-string file:///dev/stdin \
  --query VersionId \
  --output text)" || die "put-secret-value on $SECRET_ID failed"
unset key

echo "Uploaded \"$ITEM\" to $SECRET_ID as version $version."

if [[ "$REDEPLOY" == "1" ]]; then
  service_arn="$(aws apprunner list-services \
    --region "$AWS_REGION" \
    --query "ServiceSummaryList[?ServiceName=='$P8_SECRET_PREFIX'].ServiceArn | [0]" \
    --output text)"
  [[ -n "$service_arn" && "$service_arn" != "None" ]] ||
    die "no App Runner service named $P8_SECRET_PREFIX"
  aws apprunner start-deployment \
    --service-arn "$service_arn" \
    --region "$AWS_REGION" \
    --query OperationId \
    --output text >/dev/null ||
    die "uploaded version $version, but start-deployment failed (a deployment may already be running); rerun with --redeploy later"
  echo "Started a deployment of $P8_SECRET_PREFIX; it picks up the new value."
else
  echo "Next: set $KEY_ID_VAR in terraform/terraform.tfvars to this key's id and run"
  echo "terraform apply. A changed key id redeploys the service. Re-uploading the same"
  echo "key changes nothing in Terraform, so rerun with --redeploy instead."
fi
