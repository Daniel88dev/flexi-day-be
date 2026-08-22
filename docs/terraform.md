# Terraform

`terraform/` defines everything Flexi Day runs on in AWS: the App Runner service, RDS Postgres, the
VPC around it, the Route 53 records for `api.flexi-day.com`, the Secrets Manager entries App Runner
injects, and the IAM roles tying them together. Nothing here was clicked together in the console, so
an infrastructure change that skips these files never reaches production.

State is a local file, `terraform/terraform.tfstate`, gitignored, with no S3 backend. It lives on one
machine and plans only run from that checkout.

## Adding an environment variable

First decide whether the value is a secret. A secret grants access when it leaks: API keys, OAuth
client secrets, connection strings. Everything else is a plain runtime env var, including values that
feel private but appear in any browser session, such as the Paddle price IDs and the Google and
Microsoft client IDs.

Both kinds touch these five files:

1. `src/config.ts` parses and validates the value. A required variable that is missing throws at
   boot, which is the behaviour you want. An optional one needs a documented default.
2. `.env.example` documents it for local development.
3. `terraform/variables.tf` declares it, with `sensitive = true` on secrets and a `description` that
   says where the value comes from.
4. `terraform/terraform.tfvars.example` shows it empty, with whatever the reader needs in order to
   obtain the real value (which console, which redirect URI, which expiry to diarise).
5. `terraform/terraform.tfvars` gets the same key with an empty value. That file is gitignored and
   holds the live production values, so append the key and stop there. Say in your summary that the
   apply fails until the user fills it in.

A plain value then goes into `runtime_environment_variables` in `apprunner.tf` and you are done. A
secret needs four more edits:

- `secrets.tf`: an `aws_secretsmanager_secret` plus its `aws_secretsmanager_secret_version`, with
  `recovery_window_in_days = 0` so a destroy and re-apply cycle is not blocked by a name still
  scheduled for deletion.
- `apprunner.tf`: the secret's ARN in `runtime_environment_secrets`, never the value.
- `iam.tf`: that ARN appended to the `Resource` list of `aws_iam_role_policy.apprunner_secrets`.
  Forget this and the service will not start, because App Runner cannot resolve a secret the
  instance role cannot read.
- `apprunner.tf`: the secret version added to the service's `depends_on`.

App Runner injects one whole secret per env var and cannot pull a key out of a JSON secret, so give
each variable its own plain-string secret.

### Optional blocks

A feature that ships switched off follows the shape Paddle, Google and Microsoft already use. One
variable defaults to `""` and acts as the switch, each secret carries
`count = var.switch != "" ? 1 : 0`, and the App Runner env maps `merge()` in an empty object when the
switch is unset. Guard the rest with `lifecycle { precondition { ... } }` in `secrets.tf` so a
half-filled config fails at plan time rather than putting App Runner into a boot loop against
`config.ts`.

### Done when

`terraform validate` passes and `terraform plan` shows exactly the env var, secret and policy change
you intended and nothing else. Hand the plan to the user and let them apply.

## Adding an IAM permission

`iam.tf` holds two App Runner roles that are easy to confuse. The ECR access role only pulls the
image at deploy time. The instance role is what the running application has, so every AWS call the
backend makes needs a policy attached to `aws_iam_role.apprunner_instance`. Add one
`aws_iam_role_policy` per service, following `apprunner_ses`, rather than widening an existing one.

Reach for a `Condition` before you narrow `Resource`. The SES policy is deliberately `Resource = "*"`
because a templated send evaluates the IAM resource against the recipient identity, and recipients
are arbitrary user addresses that cannot be enumerated. `ses:FromAddress` constrains it instead. The
comment above that policy records what broke last time it was tightened. Read it before touching it.

## Adding an AWS resource

One file per area, listed in the header comment of `main.tf`. Add a file only for a genuinely new
area and update that list when you do. Tags come from `default_tags` in `provider.tf`, so a resource
only needs its own `Name` tag.

## Before you plan

- Applies belong to the user. Run `terraform fmt`, `terraform validate` and `terraform plan`, show
  the plan, and stop there.
- No CI runs Terraform, and no npm script wraps it. Nothing catches a variable declared but never
  injected, or a `terraform.tfvars.example` that has drifted from `variables.tf`. Reading both is the
  whole check.
- Every secret sits in plain text in `terraform.tfstate`, including the generated RDS password and
  the Better Auth secret. Passing a value as `TF_VAR_*` instead of writing it into
  `terraform.tfvars` changes nothing about that.
- Advancing `better_auth_rotation_days` signs out every active user and voids pending verification
  and reset tokens. It is not a knob to adjust in passing.
- Schema migrations do not run from Terraform, from `cd.yml`, or from the deploy.
  `npm run db:migrate:prod` applies them, reading the connection string from the same Secrets
  Manager entry Terraform creates. **The user runs that, never you**, on the same footing as
  `terraform apply`; the Migrations section of `CLAUDE.md` has the rule and the script enforces it.
  A change that needs a migration needs that step called out on its own. The `psql_command` output
  opens a shell on the same database.
- `terraform destroy` against production would take the database with it. `deletion_protection`,
  which is on only while `environment = "production"`, is the sole thing in the way.
- The files carry their own traps in comments, such as the two-step DNS rollout in `dns.tf` and the
  rotation window in `secrets.tf`. Read the file you are about to edit.
