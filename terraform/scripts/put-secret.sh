#!/usr/bin/env bash
#
# Upload a secret from 1Password into the Secrets Manager slot Terraform made for it.
#
#   terraform/scripts/put-secret.sh apple                     Sign in with Apple key (.p8)
#   terraform/scripts/put-secret.sh apns                      APNs key (.p8)
#   terraform/scripts/put-secret.sh anthropic-api-key         Anthropic key, flexi-day-prod workspace
#   terraform/scripts/put-secret.sh anthropic-webhook-secret  Anthropic webhook signing secret
#   ... --redeploy                                            also start an App Runner deployment
#
# Terraform owns these slots and never their values (docs/terraform.md). The
# item is looked up by title in the Development vault, then read by its id,
# because an op:// path can't hold the parentheses in "(prod)". The value goes
# into a variable, is checked, and only then is piped into put-secret-value,
# so a failed read never stores an empty secret and the value never appears in
# argv, shell history or the terminal. App Runner reads a secret only at
# deployment, so --redeploy is how a re-upload reaches the running service.
#
# SECRET_PREFIX (default flexi-day-be-production) is <project>-<environment>,
# naming both the slots and the App Runner service. AWS_REGION defaults to
# eu-central-1.

set -euo pipefail
# bash -x would print the value.
set +x

die() {
  echo "put-secret: $*" >&2
  exit 1
}

usage() {
  echo "usage: $0 apple|apns|anthropic-api-key|anthropic-webhook-secret [--redeploy]" >&2
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

: "${SECRET_PREFIX:=flexi-day-be-production}"
: "${AWS_REGION:=eu-central-1}"
VAULT="Development"

case "$KIND" in
  apple)
    ITEM="Flexi Day Sign in with Apple key"
    SLOT="apple-private-key"
    FORMAT="pem"
    NEXT="Set apple_key_id in terraform/terraform.tfvars to this key's id and run terraform apply."
    ;;
  apns)
    ITEM="Flexi Day APNs key"
    SLOT="apns-private-key"
    FORMAT="pem"
    NEXT="Set apns_key_id in terraform/terraform.tfvars to this key's id and run terraform apply."
    ;;
  anthropic-api-key)
    ITEM="Flexi Day Anthropic API key (prod)"
    SLOT="anthropic-api-key"
    FORMAT="sk-ant-"
    NEXT="The apply that switches the Assistant on deploys it. While it is on, rerun with --redeploy."
    ;;
  anthropic-webhook-secret)
    ITEM="Flexi Day Anthropic webhook secret (prod)"
    SLOT="anthropic-webhook-secret"
    FORMAT="whsec_"
    NEXT="The apply that switches the Assistant on deploys it. While it is on, rerun with --redeploy."
    ;;
  *) usage ;;
esac
SECRET_ID="$SECRET_PREFIX-$SLOT"

need op
need aws
need jq
[[ "$FORMAT" == "pem" ]] && need openssl

aws secretsmanager describe-secret \
  --secret-id "$SECRET_ID" \
  --region "$AWS_REGION" >/dev/null ||
  die "no secret $SECRET_ID; run terraform apply first so it exists"

item_id="$(op item get "$ITEM" --vault "$VAULT" --format json | jq -r '.id // empty')" ||
  die "could not find \"$ITEM\" in the $VAULT vault"
[[ -n "$item_id" ]] || die "could not find \"$ITEM\" in the $VAULT vault"

if [[ "$FORMAT" == "pem" ]]; then
  value="$(op document get "$item_id" --vault "$VAULT")" ||
    die "could not read \"$ITEM\" from the $VAULT vault"
else
  value="$(op read "op://$VAULT/$item_id/credential")" ||
    die "could not read the credential of \"$ITEM\" from the $VAULT vault"
fi

[[ -n "$value" ]] || die "\"$ITEM\" is empty; nothing uploaded"

if [[ "$FORMAT" == "pem" ]]; then
  [[ "$value" == "-----BEGIN PRIVATE KEY-----"* ]] ||
    die "\"$ITEM\" is not a PEM private key; nothing uploaded"
  # A truncated key keeps its header, so parse the whole thing.
  printf '%s' "$value" | openssl pkey -noout 2>/dev/null ||
    die "\"$ITEM\" does not parse as a private key; nothing uploaded"
else
  [[ "$value" == "$FORMAT"* ]] ||
    die "\"$ITEM\" does not start with $FORMAT; nothing uploaded"
  [[ "$value" != *[[:space:]]* ]] ||
    die "\"$ITEM\" contains whitespace; nothing uploaded"
fi

version="$(printf '%s' "$value" | aws secretsmanager put-secret-value \
  --secret-id "$SECRET_ID" \
  --region "$AWS_REGION" \
  --secret-string file:///dev/stdin \
  --query VersionId \
  --output text)" || die "put-secret-value on $SECRET_ID failed"
unset value

echo "Uploaded \"$ITEM\" to $SECRET_ID as version $version."

if [[ "$REDEPLOY" == "1" ]]; then
  service_arn="$(aws apprunner list-services \
    --region "$AWS_REGION" \
    --query "ServiceSummaryList[?ServiceName=='$SECRET_PREFIX'].ServiceArn | [0]" \
    --output text)"
  [[ -n "$service_arn" && "$service_arn" != "None" ]] ||
    die "no App Runner service named $SECRET_PREFIX"
  aws apprunner start-deployment \
    --service-arn "$service_arn" \
    --region "$AWS_REGION" \
    --query OperationId \
    --output text >/dev/null ||
    die "uploaded version $version, but start-deployment failed (a deployment may already be running); rerun with --redeploy later"
  echo "Started a deployment of $SECRET_PREFIX; it picks up the new value."
else
  echo "Next: $NEXT"
  echo "Re-uploading a value Terraform already wires changes nothing in Terraform, so"
  echo "rerun with --redeploy instead."
fi
