#!/usr/bin/env bash
#
# Apply Drizzle migrations to a database.
#
#   scripts/db-migrate.sh local           migrate the DATABASE from .env
#   scripts/db-migrate.sh prod            migrate RDS, credentials pulled from Secrets Manager
#   scripts/db-migrate.sh prod --status   print the applied ledger and exit, no writes
#   scripts/db-migrate.sh prod --reset    drop the whole schema first, then migrate
#
# --yes skips the confirmation prompt on an ordinary migrate. Dropping a
# production database is never unattended: `prod --reset` asks for the typed
# phrase even with --yes, even under DB_MIGRATE_CI.
#
# A PRODUCTION MIGRATION IS RUN BY A HUMAN, NEVER BY AN AGENT. The prod target
# refuses to start unless stdin is a terminal, which is what stops a coding
# agent or a stray script from applying DDL to the live database. CD can set
# DB_MIGRATE_CI=1 to opt out once someone has decided that is what they want.
# --status only reads, so it stays open to anyone.
#
# The connection string is never printed and never passed as a command-line
# argument, where `ps` and /proc would expose it to every other local user.
# psql receives the parts through libpq's PG* environment variables and
# drizzle-kit receives the whole URL through DATABASE.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

TARGET="${1:-}"
shift || true

DO_RESET=0
DO_STATUS=0
ASSUME_YES=0

for arg in "$@"; do
  case "$arg" in
    --reset) DO_RESET=1 ;;
    --status) DO_STATUS=1 ;;
    --yes | -y) ASSUME_YES=1 ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

: "${AWS_REGION:=eu-central-1}"
: "${DB_SECRET_ID:=flexi-day-be-production-database-url}"
CA_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/flexi-day"
CA_PATH="$CA_DIR/rds-global-bundle.pem"
RESET_PHRASE="drop production data"

die() {
  echo "error: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but not on PATH"
}

# Host and database only. Never the credentials.
describe_url() {
  sed -E 's#^([a-z]+)://[^@]*@#\1://#; s#\?.*$##' <<<"$1"
}

# force=1 means --yes does not apply. Used for the production reset, where
# unattended is never the right answer.
urldecode() {
  printf '%b' "${1//%/\\x}"
}

# libpq reads these, so psql never takes the credentials on its command line.
# Process arguments are world-readable through `ps` and /proc; the environment
# of a running process is not.
export_pg_env() {
  local url="$1" rest query userinfo hostport user pass host port dbname kv k v

  rest="${url#*://}"
  query=""
  if [[ "$rest" == *\?* ]]; then
    query="${rest#*\?}"
    rest="${rest%%\?*}"
  fi

  userinfo=""
  if [[ "$rest" == *@* ]]; then
    userinfo="${rest%%@*}"
    rest="${rest#*@}"
  fi

  hostport="${rest%%/*}"
  dbname="${rest#*/}"
  user="${userinfo%%:*}"
  pass=""
  if [[ "$userinfo" == *:* ]]; then pass="${userinfo#*:}"; fi
  host="${hostport%%:*}"
  port=""
  if [[ "$hostport" == *:* ]]; then port="${hostport#*:}"; fi

  if [[ -n "$host" ]]; then export PGHOST="$(urldecode "$host")"; fi
  if [[ -n "$port" ]]; then export PGPORT="$port"; fi
  if [[ -n "$user" ]]; then export PGUSER="$(urldecode "$user")"; fi
  if [[ -n "$pass" ]]; then export PGPASSWORD="$(urldecode "$pass")"; fi
  if [[ -n "$dbname" ]]; then export PGDATABASE="$(urldecode "$dbname")"; fi

  local IFS='&'
  for kv in $query; do
    k="${kv%%=*}"
    v="${kv#*=}"
    case "$k" in
      sslmode) export PGSSLMODE="$(urldecode "$v")" ;;
      sslrootcert) export PGSSLROOTCERT="$(urldecode "$v")" ;;
    esac
  done

  return 0
}

confirm() {
  local prompt="$1" expected="$2" force="${3:-0}" answer
  if [[ "$ASSUME_YES" == "1" && "$force" != "1" ]]; then
    return 0
  fi
  echo
  echo "$prompt"
  read -r -p "Type '$expected' to continue: " answer
  [[ "$answer" == "$expected" ]] || die "aborted"
}

resolve_local_url() {
  if [[ -n "${DATABASE:-}" ]]; then
    echo "$DATABASE"
    return
  fi
  [[ -f .env ]] || die "no DATABASE in the environment and no .env file"
  local line
  line="$(grep -E '^[[:space:]]*DATABASE=' .env | head -1 | cut -d= -f2-)"
  [[ -n "$line" ]] || die "no DATABASE= line in .env"
  # Strip surrounding quotes and a trailing comment.
  line="${line%%#*}"
  line="$(sed -E 's/^[[:space:]]*//; s/[[:space:]]*$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/' <<<"$line")"
  echo "$line"
}

resolve_prod_url() {
  need aws
  local url
  url="$(aws secretsmanager get-secret-value \
    --secret-id "$DB_SECRET_ID" \
    --region "$AWS_REGION" \
    --query SecretString \
    --output text)" || die "could not read $DB_SECRET_ID from Secrets Manager"
  [[ "$url" == postgres* ]] || die "secret $DB_SECRET_ID does not look like a connection string"

  # RDS enforces TLS (rds.force_ssl=1). Verify it properly rather than
  # disabling the check: the global bundle is the CA RDS certificates chain to,
  # and both libpq and node-postgres read these two query parameters.
  if [[ ! -s "$CA_PATH" ]]; then
    need curl
    mkdir -p "$CA_DIR"
    curl -fsS -o "$CA_PATH" https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem ||
      die "could not download the RDS CA bundle"
  fi

  local sep="?"
  [[ "$url" == *\?* ]] && sep="&"
  echo "${url}${sep}sslmode=verify-full&sslrootcert=${CA_PATH}"
}

case "$TARGET" in
  local) DATABASE_URL="$(resolve_local_url)" ;;
  prod) DATABASE_URL="$(resolve_prod_url)" ;;
  *)
    echo "usage: $0 <local|prod> [--status] [--reset] [--yes]" >&2
    exit 2
    ;;
esac

echo "target:   $TARGET"
echo "database: $(describe_url "$DATABASE_URL")"

if [[ "$DO_STATUS" == "1" ]]; then
  need psql
  export_pg_env "$DATABASE_URL"
  psql -v ON_ERROR_STOP=1 -c "
    select id,
           left(hash, 12) as hash,
           to_timestamp(created_at / 1000) at time zone 'UTC' as applied_at
    from drizzle.__drizzle_migrations
    order by created_at;"
  exit 0
fi

# A human at a keyboard is the gate on every production write. An agent's shell
# has no controlling terminal, so this is what makes "never migrate prod from an
# agent" a fact rather than a request.
if [[ "$TARGET" == "prod" && ! -t 0 && "${DB_MIGRATE_CI:-0}" != "1" ]]; then
  echo "error: a production migration must be started by a person at a terminal." >&2
  echo "       If you are an agent, stop here and hand these commands to the user." >&2
  echo "       CD may set DB_MIGRATE_CI=1 to run unattended." >&2
  exit 3
fi

if [[ "$DO_RESET" == "1" ]]; then
  need psql
  reset_force=0
  if [[ "$TARGET" == "prod" ]]; then reset_force=1; fi
  confirm "This DROPS every table, every row and the migration ledger on the database above." \
    "$RESET_PHRASE" "$reset_force"
  export_pg_env "$DATABASE_URL"
  psql -v ON_ERROR_STOP=1 -1 <<'SQL'
DROP SCHEMA IF EXISTS drizzle CASCADE;
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
SQL
  echo "schema dropped and recreated"
fi

if [[ "$TARGET" == "prod" && "$DO_RESET" != "1" ]]; then
  confirm "About to apply pending migrations to PRODUCTION." "yes"
fi

DATABASE="$DATABASE_URL" npx drizzle-kit migrate

echo "migrations applied"
