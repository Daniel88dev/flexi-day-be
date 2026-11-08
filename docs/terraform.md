# Terraform

`terraform/` defines everything Flexi Day runs on in AWS: the App Runner service, RDS Postgres, the
VPC around it, the Route 53 records for `api.flexi-day.com`, the Secrets Manager entries App Runner
injects, the attachments bucket with the Lambda that checks uploads, the organization-data bucket
and its KMS key, and the IAM roles tying them together. Nothing here was clicked together in the console, so an infrastructure change that skips
these files never reaches production.

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

The two Apple `.p8` keys and the two Anthropic secrets are the exception: a slot with no secret
version, so nothing of theirs goes in `depends_on`. See
[Secrets Terraform never sees](#secrets-terraform-never-sees).

### Optional blocks

A feature that ships switched off follows the shape Paddle, Google, Microsoft and Apple already
use. One variable defaults to `""` and acts as the switch, each secret carries
`count = var.switch != "" ? 1 : 0`, and the App Runner env maps `merge()` in an empty object when the
switch is unset. Guard the rest with `lifecycle { precondition { ... } }` in `secrets.tf` so a
half-filled config fails at plan time rather than putting App Runner into a boot loop against
`config.ts`.

The `.p8` and Anthropic slots break this shape: none has a `count`, and `apple_client_id`,
`apns_key_id` and the Assistant switch only their App Runner wiring.
[Secrets Terraform never sees](#secrets-terraform-never-sees) explains why.

### Secrets Terraform never sees

Four secrets never pass through Terraform: the Sign in with Apple key, the APNs key, the Anthropic
API key and the Anthropic webhook signing secret. Terraform creates each slot in Secrets Manager,
puts its ARN on the instance role and, while its switch is on, in `runtime_environment_secrets`,
and stops there. It never writes a secret version, so no value reaches state, a plan or
`terraform.tfvars`, and no `TF_VAR_*` carries one.

`terraform/scripts/put-secret.sh apple|apns|anthropic-api-key|anthropic-webhook-secret` uploads one
from the `Development` vault in 1Password:

| Kind                       | 1Password item                                | Check                                    |
| -------------------------- | --------------------------------------------- | ---------------------------------------- |
| `apple`                    | `Flexi Day Sign in with Apple key` (Document) | PEM header, and `openssl pkey` parses it |
| `apns`                     | `Flexi Day APNs key` (Document)               | PEM header, and `openssl pkey` parses it |
| `anthropic-api-key`        | `Flexi Day Anthropic API key (prod)`          | `credential` starts with `sk-ant-`       |
| `anthropic-webhook-secret` | `Flexi Day Anthropic webhook secret (prod)`   | `credential` starts with `whsec_`        |

The script finds the item by title, then reads it by id, since an `op://` path can't hold the
parentheses in `(prod)`. The value lands in a variable and is checked before anything is uploaded,
so a failed read never stores an empty secret, then it is piped into
`aws secretsmanager put-secret-value --secret-string file:///dev/stdin`, so it never lands in argv,
shell history or the terminal. It prints the next step. App Runner reads a secret only at
deployment, so a new value waits for the next one: an apply that changes the service redeploys,
and `--redeploy` starts one itself, which you need when re-uploading into a slot already wired.

Each switched-on slot has an ephemeral `aws_secretsmanager_secret_version` in `secrets.tf`.
Terraform reads it on every plan and apply and stores nothing. A slot with no value fails the read,
and a value without the expected start (the PEM header, `sk-ant-`, `whsec_`) fails its
postcondition, so either one stops `terraform plan` instead of booting a backend that throws on
the value. The check covers the start only: prove a new Apple key locally first, in `.env` with its
ids, where the backend parses it at boot.

Terraform no longer notices a value changed in AWS by hand. The `terraform.tfstate.backup` files
written before this change still hold the old Apple key, like every other secret in state.

### Sign in with Apple

`apple_client_id`, the Services ID, is the switch. With it set, `apple_team_id`, `apple_key_id` and
`apple_app_bundle_identifier` ride as plain env vars beside it, and the slot
`<project>-<environment>-apple-private-key` reaches the service as the runtime secret
`APPLE_PRIVATE_KEY`. A precondition on the slot fails the plan when the switch is set without the
other three ids, because `buildSocialProviders` registers Apple only when all five reach it. The
key itself goes up with `put-secret.sh apple`.

The slot exists whether or not the switch is set, so in a fresh environment the key goes up before
Apple is switched on: `terraform apply`, then `put-secret.sh apple`, then set `apple_client_id` and
apply again. With the switch set and the slot empty, the plan stops before it changes anything.

The key used to be written by Terraform from `TF_VAR_apple_private_key`. A `removed` block with
`destroy = false` forgets that secret version, so the live value stays and nothing is uploaded
again.

Nothing here expires: the backend signs its own one-hour client secrets with the key. To replace
the key, in one sitting:

1. Register a second key in Apple's portal (two per App ID) and save its `.p8` into the existing
   1Password item.
2. `terraform/scripts/put-secret.sh apple`
3. Set the new `apple_key_id` in `terraform.tfvars`.
4. `terraform apply`. The changed key id redeploys the service.
5. Revoke the old key in Apple's portal.

An image push between steps 2 and 4 deploys the new key with the old key id, and Apple sign-in
fails until the apply.

Apple POSTs the web callback, so `apprunner.tf` appends `https://appleid.apple.com` to
`TRUSTED_ORIGINS` whenever the switch is set. Leave it out of `trusted_origins`: that list also
feeds the attachments bucket's CORS rule, which is for browser origins.

### Push notifications (APNs)

The slot `<project>-<environment>-apns-private-key` always exists, with its ARN on the instance
role, so the key can go up before the service needs it. `apns_key_id` is the switch. With it set,
App Runner gets `APNS_KEY_ID`, `APNS_TEAM_ID` from `apple_team_id`, `APNS_TOPIC` from
`apple_app_bundle_identifier`, and the runtime secret `APNS_PRIVATE_KEY`. It reuses those two values
but not the Sign in with Apple switch, so push runs with `apple_client_id` empty. A precondition
fails the plan when `apns_key_id` is set without them.

First rollout:

1. `terraform apply` creates the empty slot.
2. `terraform/scripts/put-secret.sh apns`
3. Set `apns_key_id` in `terraform.tfvars`.
4. `terraform apply` wires the slot into App Runner and redeploys. If step 2 was skipped, the
   plan-time check stops this apply.

To replace the key, in one sitting:

1. Create a new APNs key in Apple's portal and save its `.p8` into the existing `Flexi Day APNs key`
   item in 1Password, with its key id.
2. `terraform/scripts/put-secret.sh apns`
3. Set the new `apns_key_id` in `terraform.tfvars`.
4. `terraform apply`. The changed key id redeploys the service.
5. Revoke the old key in Apple's portal.

An image push between steps 2 and 4 deploys the new key with the old key id, and push fails until
the apply.

### Done when

`terraform validate` passes and `terraform plan` shows exactly the env var, secret and policy change
you intended and nothing else. Hand the plan to the user and let them apply.

## Calendar direct sync switches

`calendar_sync_google_enabled` and `calendar_sync_microsoft_enabled` are booleans, default `false`,
that reach App Runner as the plain env vars `CALENDAR_SYNC_GOOGLE_ENABLED` and
`CALENDAR_SYNC_MICROSOFT_ENABLED` (`"true"` or `"false"`). They add no secrets: a connection reuses
its provider's sign-in client, so a switch does nothing while `google_client_id` or
`microsoft_client_id` is empty. `CALENDAR_SYNC_DRIVER` is deliberately absent; the backend defaults
to the live driver and refuses `fake` when `NODE_ENV=production`.

Both callback URIs must be registered next to the sign-in ones:
`https://api.flexi-day.com/api/calendar-sync/connections/google/callback` in the Google Cloud console
and `https://api.flexi-day.com/api/calendar-sync/connections/microsoft/callback` on the Entra app
registration. T-297 and T-298 registered them on 2026-10-11.

Roll out in this order:

1. Deploy the backend and apply with both switches `false`.
2. Deploy the web app. Its connect buttons stay hidden while both switches are off.
3. Set `calendar_sync_google_enabled = true` and apply. Until Google verifies the OAuth app for the
   calendar scope (T-302), users see the unverified-app warning and the app is capped at 100 users
   for life.
4. Set `calendar_sync_microsoft_enabled = true` and apply only after Entra publisher verification
   (T-301). Before it, users in other companies' tenants cannot consent to the calendar scopes.

Each flip changes only the App Runner env, which rolls out a new deployment.

## Assistant and AI connections

The Assistant and AI connections ship dark and are run from three places: the Terraform variables
below, the Anthropic Console, and `scripts/assistant-setup.sh`, a wizard that walks the owner
through every Console click, 1Password save, `gh` change and `terraform apply` in order. Every one
of those steps is the owner's. A build ticket writes the Terraform and the wizard, runs `plan`, and
stops.

### What reaches App Runner

| Variable                                                | App Runner                                       | When                       |
| ------------------------------------------------------- | ------------------------------------------------ | -------------------------- |
| `assistant_enabled`, `ai_connections_enabled`           | `ASSISTANT_ENABLED`, `AI_CONNECTIONS_ENABLED`    | always                     |
| `ai_preview_organization_ids`                           | `AI_PREVIEW_ORGANIZATION_IDS`                    | when the list is not empty |
| `assistant_driver`, `assistant_weekly_limit_usd`        | `ASSISTANT_DRIVER`, `ASSISTANT_WEEKLY_LIMIT_USD` | always                     |
| `kb_bundle_url`                                         | `KB_BUNDLE_URL`                                  | always                     |
| `assistant_agent_id`, `assistant_environment_id`        | `ASSISTANT_AGENT_ID`, `ASSISTANT_ENVIRONMENT_ID` | while the Assistant is on  |
| slot `<project>-<environment>-anthropic-api-key`        | secret `ANTHROPIC_API_KEY`                       | while the Assistant is on  |
| slot `<project>-<environment>-anthropic-webhook-secret` | secret `ANTHROPIC_WEBHOOK_SECRET`                | while the Assistant is on  |

"The Assistant is on" means `assistant_enabled = true` or a non-empty preview list, because a
preview organization gets both features with the switches off. `local.assistant_reachable` in
`apprunner.tf` holds that rule, and `config.ts` applies the same one at boot. In production it
refuses to start without the key, the webhook secret and both ids while the Assistant is on, and
without `KB_BUNDLE_URL` while either feature is on. Terraform fails the plan first: a precondition
on the service wants both ids, the ephemeral reads in `secrets.tf` want the two slots filled with
`sk-ant-` and `whsec_` values, `kb_bundle_url` must be an https URL, and `assistant_driver` can't be
`fake` in production.

Both slots always exist, so the values go up before the Assistant is switched on, the same way as
the `.p8` keys ([Secrets Terraform never sees](#secrets-terraform-never-sees)). The ids are public
and live in `terraform.tfvars`. `pnpm run assistant:provision` prints them for the workspace whose
key it runs with.

### Anthropic workspaces

| Workspace        | Spend limit | Email alert | Members         | Used by                                              |
| ---------------- | ----------- | ----------- | --------------- | ---------------------------------------------------- |
| `flexi-day-prod` | $200/month  | $100        | the owner alone | App Runner, through the two slots                    |
| `flexi-day-dev`  | $20/month   | $10         | anyone working  | `.env` when `ASSISTANT_DRIVER=managed`               |
| `flexi-day-eval` | $20/month   | $10         | anyone working  | the `assistant-eval` GitHub environment, `.env.eval` |

The Console's session viewer shows every transcript to each Developer and Admin of a workspace,
which is why `flexi-day-prod` has no member but the owner. Raising a limit is the owner's decision.
When Anthropic refuses for a spend limit or for credits, every organization sees "Assistant
unavailable" (`ASSISTANT_UNAVAILABLE`).

### Setup

`scripts/assistant-setup.sh <stage>` runs one stage. Each step says what to do, and nothing that
writes a file, a secret, a GitHub setting or AWS runs until you confirm it.

| Stage            | What it covers                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `dev`            | the dev workspace and its limits, the dev key into 1Password and `.env`, `assistant:provision`, the ids in `.env`               |
| `eval`           | the eval workspace and its limits, the eval key into the `assistant-eval` environment and `.env.eval`                           |
| `prod`           | the prod workspace, limits and members, both secrets, the prod provision, the webhook, OTel, Sentry's budget, the preview apply |
| `required-check` | `assistant-eval` as a required check on `main`, once the eval workflow runs there                                               |
| `launch`         | AI connections on (day 0), then the Assistant on (day 30 after the notice, with a passing baseline)                             |

The `prod` stage, in order:

1. Both repos deploy with both switches `false` and an empty preview list, and both Terraform roots
   are applied. That creates the two empty slots and the frontend's headers policy.
2. Create `flexi-day-prod`, set its limit and alert, and check its members.
3. Create its key, save it in 1Password as `Flexi Day Anthropic API key (prod)`, and run
   `terraform/scripts/put-secret.sh anthropic-api-key`.
4. Run `pnpm run assistant:provision` with that key and put the two ids in `terraform.tfvars`.
5. Register the webhook in the prod workspace: `https://api.flexi-day.com/api/webhooks/anthropic`,
   event `session.status_idled`. Save its signing secret as
   `Flexi Day Anthropic webhook secret (prod)` and run
   `terraform/scripts/put-secret.sh anthropic-webhook-secret`.
6. Add the OpenTelemetry destination to the `flexi-day-be` Sentry project, Metadata only, in the
   prod workspace alone.
7. Set Sentry's $10 a month pay-as-you-go budget if the organization has none.
8. Add your own organization's id to `ai_preview_organization_ids` and apply. The plan reads both
   slots and fails if either is empty, and the apply wires the secrets and ids in.

The webhook route answers 404 until step 8, so a test delivery sent before then fails. Send it
again after the apply. A missed webhook costs nothing lasting: opening the chat resumes a stalled
turn.

### Launch

1. Day 0: once the AI connection texts are published and the notice email has gone out (record the
   send time), set `ai_connections_enabled = true` and apply.
2. Day 30 after that send, with a passing eval baseline on `main`: set `assistant_enabled = true`
   and apply.

Each flip changes only the App Runner env, which rolls out a new deployment.

### Kill switches

Set the switch to `false` and apply. The feature's routes answer 404 and the web app hides it once
the deployment is live, a few minutes after the apply. Nothing is deleted: chats, AI connections and
their grants stay, and retention keeps running.

- `assistant_enabled = false` stops the Assistant for everyone off the preview list. With the list
  empty too, the plan also takes the two secrets and the ids out of App Runner; the slots keep
  their values for the next switch-on.
- `ai_connections_enabled = false` stops `/mcp`, its OAuth discovery and consent for everyone off
  the preview list.
- A preview organization keeps both features while it is on the list. Remove its id and apply to
  stop them there too.

When the Anthropic side is what's wrong, the Console's workspace spend limit stops every call at
once without a deploy. Users then see "Assistant unavailable".

### Rotating the Anthropic key

1. Create a new key in `flexi-day-prod` and save it into the existing
   `Flexi Day Anthropic API key (prod)` item, replacing the old value.
2. `terraform/scripts/put-secret.sh anthropic-api-key --redeploy`
3. Wait for the deployment to finish, then revoke the old key in the Console.

A revoked key that is still deployed fails every Assistant turn, so step 3 waits for step 2.

### Rotating the webhook secret

1. Roll the endpoint's signing secret in the Console and save the new one into
   `Flexi Day Anthropic webhook secret (prod)`.
2. `terraform/scripts/put-secret.sh anthropic-webhook-secret --redeploy`

Until the deployment is live, deliveries fail the signature check and log
`assistant.webhook_rejected`. The turns they announced resume when their chat is opened.

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

## Attachments: bucket, Lambda and CD

`attachments.tf` holds the upload pipeline of ADR 0003. The bucket is private: public access
blocked, ACLs disabled through `BucketOwnerEnforced`, SSE-S3 by default. Terraform sets nothing on
versioning, so it stays at S3's default, off. The lifecycle rules back up the API's nightly sweep
rather than replace it. Objects under `incoming/` expire after a day. Everything else expires 1190
days after upload, which lands past the sweep's twelve months from the Request's last day even for
a Request booked on the last bookable day, 31 December of next year; the sweep, not the rule, is
what normally removes a file. CORS allows GET and POST from the http(s) entries of
`trusted_origins` — both presigned requests run in the browser, and the list also carries the phone
app's URL scheme, which no browser sends.

The `attachment-processor` Lambda has a role of its own: list the bucket, get under `incoming/`,
put anywhere except `incoming/`, delete anywhere (the incoming object once handled, and a final
object it wrote for a row the API reports gone), read the callback secret, write its log group.
The list right is there so S3 reports a missing incoming object as `NoSuchKey`, which the handler
treats as already processed, instead of `AccessDenied`, which it would retry. The S3 notification on
`incoming/` invokes it, and `aws_lambda_permission` lets the bucket do so. The App Runner instance
role gets `apprunner_attachments`, a policy of its own as the IAM section above asks: put under
`incoming/` for the presigned upload, get and delete on the whole bucket for downloads and removals.
The callback secret sits in `secrets.tf` beside the others. App Runner receives it as
`ATTACHMENTS_CALLBACK_SECRET`; the Lambda receives its ARN and reads the value once per container.
`apprunner.tf` also carries `ATTACHMENTS_BUCKET`, which `config.ts` requires in production and uses
to select the S3 store.

Terraform creates the function with a placeholder zip and ignores its code from then on. The code
ships from `cd.yml`: `pnpm run lambda:build` bundles `src/lambda/attachmentProcessor` with the
shared processor into `lambda/attachment-processor/attachment-processor.zip` (sharp and libheif-js
installed for linux/x64 from that directory's own lockfile), and the `deploy-attachment-processor`
job uploads it with `aws lambda update-function-code`. The job is skipped until the
`ATTACHMENT_PROCESSOR_FUNCTION_NAME` repository variable exists, so the first rollout is: apply, run
the `attachment_processor_cd_variable_command` output, then push or re-run the workflow.

The CD role (`GitHubActionsECRPushRole`, behind the `AWS_ROLE_ARN` repository variable) predates
Terraform. `github_actions_role_name` names it so the deploy policy can attach; Terraform never
manages the role itself.

Lambda runtimes are validated by the AWS provider against a fixed list, which is why the provider
constraint is `~> 6.0`: `nodejs24.x` does not exist in 5.x. Bumping the constraint means
`terraform init -upgrade` before the next plan.

## Organization data: bucket, key and log hygiene

`organization-data.tf` holds the bucket for organization data, `flexi-day-prod-organization-data`:
Profile photos, Person and Organization exports under `exports/`, and later per-person documents.
It mirrors `attachments` in its public-access block, `BucketOwnerEnforced` ownership and CORS rule,
and differs in four ways:

- **Versioning is on.** An old version expires 7 days after it stops being current, the same window
  as the RDS backups, so a value removed by a Retention purge or an Erase is gone from both stores
  after 7 days. Expired delete markers are cleaned up too.
- **No age-based expiry.** Retention and erasure remove objects, not the lifecycle. Only two
  prefixes expire: `incoming/` after a day, for an upload nobody processed, and `exports/` after 7
  days, the life of an export's download. Unfinished multipart uploads are aborted after a day.
- **SSE-KMS with S3 Bucket Keys** under the key below, rather than SSE-S3.
- **Profile photos reach the attachment processor.** A second notification sends `incoming/` of
  this bucket to the same Lambda, described below.

The key is a customer managed KMS key, `alias/flexi-day-be-production-organization-data`. It
encrypts the bucket and wraps each organization's data key for the Sensitive section fields, so
losing it loses all of that for good. Three guards stand in the way: `prevent_destroy`, a 30-day
deletion window, and a key policy that denies `kms:ScheduleKeyDeletion` to every principal but the
account root user, even one holding AdministratorAccess. The policy's other statement is AWS's default
grant to the account, which is what lets IAM policies work on the key at all. Rotation is automatic,
yearly; KMS keeps the old key material, so nothing is re-encrypted.

Deleting the key on purpose takes the root user, after `prevent_destroy` and the resource have left
the files. The key then waits 30 days, and `aws kms cancel-key-deletion` brings it back within that
time.

The App Runner instance role gets `apprunner_organization_data`: list the bucket, get, put and
delete objects, and `kms:GenerateDataKey` and `kms:Decrypt` on the key. S3 makes those KMS calls on
the role's behalf for every presigned upload and download, and field encryption makes them
directly. A delete under versioning leaves an old version, which the lifecycle rule removes, so the
role has no `DeleteObjectVersion`. App Runner receives `ORGANIZATION_DATA_BUCKET` and
`ORGANIZATION_DATA_KMS_KEY_ARN`. Field encryption wraps each organization's Data key with the
second ([`field-encryption.md`](field-encryption.md)).

Two log settings keep Profile values out of CloudWatch:

- The RDS parameter group sets `log_parameter_max_length = 0`. Slow-query lines (over the 1 s of
  `log_min_duration_statement`) keep their statement and drop the bound values. Error lines already
  drop them, through `log_parameter_max_length_on_error`, which defaults to 0. The parameter is
  dynamic, so it takes effect without a reboot.
- The App Runner log groups, `/aws/apprunner/<service name>/<service id>/application` and
  `/service`, keep 30 days. App Runner created them itself with no retention, so `apprunner.tf`
  brings them in with `import` blocks, and the first apply shows them as imports with an in-place
  retention change. A replaced service gets a new service id and new groups, and the plan then
  replaces these two.

The application side matches: `src/utils/queryError.ts` strips a failed query's bound values from
what the logger, `errorMiddleware` and Sentry's `beforeSend` see.

### Profile photos and the attachment processor

The browser posts a Profile photo to `incoming/<photoId>` of this bucket under a presigned POST the
API signs ([`directory.md`](directory.md#profile-photo)). Three resources at the end of
`organization-data.tf` hand it to `attachment-processor`:

- `aws_s3_bucket_notification.organization_data`: `s3:ObjectCreated:*` on `incoming/`.
- `aws_lambda_permission.organization_data_bucket`: S3 may invoke the function from this bucket.
- `aws_iam_role_policy.attachment_processor_organization_data`: list the bucket, read and delete
  `incoming/*`, write and delete `photos/*`, and `kms:Decrypt` and `kms:GenerateDataKey` on the key.

The KMS statement carries two conditions: `kms:ViaService` is S3 in the region, and
`kms:EncryptionContext:aws:s3:arn` is the bucket's ARN, which is the context S3 sends with Bucket
Keys on. Field encryption calls KMS directly with an `organizationId` context, so the Lambda can
never unwrap an organization's data key, and it never reaches `exports/`.

The function itself is unchanged. It tells the two buckets apart by the bucket name in each event
record, so it needs no new environment variable.

## RDS instance class and reserved instance

The database runs on `db.t4g.micro`, Single-AZ, and a reserved instance covers its instance hours:

| Field          | Value                                   |
| -------------- | --------------------------------------- |
| Reservation ID | `flexi-day-be-production-db-2026`       |
| Lease ID       | `ef184d37-20fc-4e98-af98-00a8dcf59428`  |
| Offering ID    | `8d0c7d59-b4ff-4689-bfc3-bc2b51e711dd`  |
| Covers         | 1 × db.t4g.micro, PostgreSQL, Single-AZ |
| Term           | 1 year, All Upfront, $104 paid once     |
| Purchased      | 2026-10-13                              |
| Expires        | 2027-10-13                              |

It covers instance hours only. Storage, backups beyond the free allowance and the public IPv4
address stay on the monthly bill.

The reservation is not a Terraform resource. It was bought by hand, because a `destroy` cannot
refund it and an apply from a fresh checkout could buy a second one. AWS matches it to the running
instance by class family, engine, deployment and region, with nothing linking the two.

**Change `db_instance_class` only within the `db.t4g` family.** RDS reservations are size-flexible
inside a family, so a move to `db.t4g.small` keeps this one counting towards the bill. A move to
another family such as `db.t3` or `db.m7g` leaves it applying to nothing, with the money already
spent. Switching `db_multi_az` on doubles the instance hours, so the reservation then covers half.

A class change on its own waits for the Monday maintenance window. To take it now, pass
`-var db_apply_immediately=true` to that one plan and apply, after a manual snapshot. Expect a few
minutes of downtime while RDS restarts the instance. The next apply without the flag shows
`apply_immediately` going back to `false`, which changes nothing on the instance.

Before the expiry date, decide whether to buy another year. Otherwise the instance falls back to
on-demand pricing without any warning.

## Rotating the Better Auth secret

`BETTER_AUTH_SECRETS` holds the Better Auth secret versions as `<version>:<secret>` pairs, newest
first, in a single Secrets Manager string, because App Runner maps one environment variable to one
secret. better-auth encrypts and signs with the newest version and decrypts with any version listed.
Terraform lists two: `better_auth_secret_version` and the one before it. Version 1 is the secret
from before versioning, which is `better_auth_secret` from `terraform.tfvars` when that is set and
`random_password.better_auth_secret` in state otherwise.

Nothing rotates on its own. Once the newest version is older than `better_auth_rotation_days` (90),
the plan prints a warning from the `better_auth_secret_age` check. To rotate, raise
`better_auth_secret_version` by one in `terraform.tfvars`, plan, and hand the apply to the user. The
apply generates the new version and drops the one before the previous. App Runner reads a secret
only at deployment, and the slot's ARN stays the same, so the version also goes into the plain
variable `BETTER_AUTH_SECRET_VERSION`: changing it is what redeploys the service, and `config.ts`
refuses to boot a deployment whose list does not end there. When
the new instance boots it deletes every session, because cookies are signed with the newest version
only, and it re-encrypts TOTP secrets, backup codes, account OAuth tokens and calendar tokens onto
the newest version. `docs/invariants.md` has both.

- Raise it by one, and only after an instance has booted on the current list. A row moves to the
  newest version only at a boot, so a jump by two, or two rotations before a deploy has run, drops
  a version rows may still be under. The boot logs those rows as `auth.secret_unreadable_rows`; a
  calendar connection among them asks its user to reconnect, and a TOTP secret among them locks
  its user out of two-factor sign-in.
- While version 1 is listed, a `better_auth_secret` set in `terraform.tfvars` must stay set: it is
  version 1. Once version 3 is current, it is no longer read.

### Moving to versions

The first apply after versioning landed lists only version 1, the existing secret, so nobody is
signed out. It starts injecting `BETTER_AUTH_SECRETS` and `BETTER_AUTH_SECRET_VERSION` beside
`BETTER_AUTH_SECRET`. Deploy the backend image that reads them first: an older image ignores both,
but the version variable makes the apply redeploy whatever image is current. That image runs fine on
`BETTER_AUTH_SECRET` alone, as version 1.

The first boot of that image moves every encrypted row into a `$ba$1$` envelope, which no image from
before versioning can read. Roll forward from then on: an older image boots, but two-factor sign-in
and calendar sync fail for everyone, and after a rotation it also signs everyone out. The old
`-better-auth-secret` slot stays in Secrets Manager with version 1's value, still injected as
`BETTER_AUTH_SECRET`, only so such an image can boot at all. Delete it after the first rotation,
with its resources in `secrets.tf` and its lines in `apprunner.tf` and `iam.tf`. Until then,
version 1 survives as better-auth's fallback key even after it leaves `BETTER_AUTH_SECRETS`.

## Before you plan

- Applies belong to the user. Run `terraform fmt`, `terraform validate` and `terraform plan`, show
  the plan, and stop there.
- No CI runs Terraform, and no package script wraps it. Nothing catches a variable declared but never
  injected, or a `terraform.tfvars.example` that has drifted from `variables.tf`. Reading both is the
  whole check.
- Every secret but the two Apple `.p8` keys and the two Anthropic secrets sits in plain text in
  `terraform.tfstate`, including the
  generated RDS password and the Better Auth secret. Passing a value as `TF_VAR_*` instead of
  writing it into `terraform.tfvars` changes nothing about that.
- Raising `better_auth_secret_version` signs out every active user and voids pending email
  verification links. It is not a knob to adjust in passing; "Rotating the Better Auth secret" above is the runbook.
- Schema migrations do not run from Terraform, from `cd.yml`, or from the deploy.
  `pnpm run db:migrate:prod` applies them, reading the connection string from the same Secrets
  Manager entry Terraform creates. **The user runs that, never you**, on the same footing as
  `terraform apply`; the Migrations section of `CLAUDE.md` has the rule and the script enforces it.
  A change that needs a migration needs that step called out on its own. The `psql_command` output
  opens a shell on the same database.
- `terraform destroy` against production would take the database with it. `deletion_protection`,
  which is on only while `environment = "production"`, is the sole thing in the way.
- The files carry their own traps in comments, such as the two-step DNS rollout in `dns.tf` and the
  secret versions in `secrets.tf`. Read the file you are about to edit.
