# Getting the Apple .p8 keys to App Runner without `terraform apply` asking for them

Research for fenro task T-325 (map T-324), 2026-10-17.

Today the Sign in with Apple `.p8` reaches Secrets Manager through `TF_VAR_apple_private_key` and
`aws_secretsmanager_secret_version.apple_private_key` (`terraform/secrets.tf`). The APNs `.p8` would
add a second key like it. Both keys live in 1Password. Terraform runs by hand on one Mac with local
state, and the other secrets stay in `terraform.tfvars` and in state either way.

Local toolchain checked for this note: Terraform 1.16.6, `hashicorp/aws` 6.63.0 (lock file), 1Password
CLI 2.41.0, AWS CLI 2.38.0.

## Facts

### Terraform

- `sensitive = true` does not keep a value out of state or plan files. "Terraform still records
  sensitive values in state." ([variable block](https://developer.hashicorp.com/terraform/language/block/variable),
  [sensitive data in state](https://developer.hashicorp.com/terraform/language/state/sensitive-data))
- A saved plan (`plan -out`) holds the input variables and every sensitive value in cleartext, and
  applying it accepts no `-var` or `-var-file`.
  ([plan](https://developer.hashicorp.com/terraform/cli/commands/plan),
  [apply](https://developer.hashicorp.com/terraform/cli/commands/apply))
- Ephemeral input variables (`ephemeral = true`, Terraform 1.10+) are left out of state and plan
  files. They can only feed write-only arguments, ephemeral resources, provider blocks, provisioners
  and other ephemeral values. ([variable block](https://developer.hashicorp.com/terraform/language/block/variable),
  [1.10.0 changelog](https://github.com/hashicorp/terraform/blob/v1.10/CHANGELOG.md))
- Because a saved plan omits ephemeral values, they must be supplied again when the plan is applied.
  The docs do not say this outright; it follows from the omission and is what users report
  ([hashicorp/terraform#36183](https://github.com/hashicorp/terraform/issues/36183)).
- Write-only arguments (Terraform 1.11+) take ephemeral or ordinary values and never store them in
  state or plan files. Terraform cannot see a change to them, so each has a `*_wo_version` companion
  that is stored, and bumping it triggers the write.
  ([write-only arguments](https://developer.hashicorp.com/terraform/language/manage-sensitive-data/write-only),
  [1.11.0 changelog](https://github.com/hashicorp/terraform/blob/v1.11/CHANGELOG.md))
- Ephemeral resources are never stored in state or plan files, and the `ephemeral` block supports
  `count`, `for_each` and `lifecycle` with `precondition` and `postcondition` on `self`.
  ([ephemeral block](https://developer.hashicorp.com/terraform/language/block/ephemeral))
- Tested locally on 1.16.6 with an `ephemeral "random_password"` that nothing referenced: Terraform
  opened it during `plan`, ran its postcondition (a failing one stopped the plan), and opened it again
  during `apply` of the saved plan. The docs do not state this.
- The `removed` block arrived in Terraform 1.7.0. `lifecycle { destroy = false }` drops the resource
  from state without destroying it, and HashiCorp recommends it over `terraform state rm` because the
  plan previews the change. `from` takes a resource address without instance keys, so it covers
  every `count` instance at once.
  ([1.7.0 changelog](https://github.com/hashicorp/terraform/blob/v1.7/CHANGELOG.md),
  [removed block](https://developer.hashicorp.com/terraform/language/block/removed),
  [remove a resource from state](https://developer.hashicorp.com/terraform/language/state/remove))

### AWS provider (`aws_secretsmanager_secret_version`)

- `secret_string_wo` and `secret_string_wo_version` exist since provider 5.88.0
  ([5.x changelog](https://github.com/hashicorp/terraform-provider-aws/blob/release/5.x/CHANGELOG.md)).
  The ephemeral resource `aws_secretsmanager_secret_version`, which returns `secret_string`, exists
  since 5.77.0 ([ephemeral resource docs](https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/ephemeral-resources/secretsmanager_secret_version.html.markdown)).
  The data source `aws_secretsmanager_secret_versions` (5.62.0) lists version ids and staging labels
  without values ([docs](https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/d/secretsmanager_secret_versions.html.markdown)).
  The data source `aws_secretsmanager_secret_version` returns the value and stores it in state like
  any data source.
- Destroying a secret version does not delete the value. The provider removes the version's staging
  labels, and when it meets `AWSCURRENT` it logs a warning and skips it, because Secrets Manager only
  lets that label move, never vanish. The version stays active.
  ([resource docs](https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/secretsmanager_secret_version.html.markdown),
  `resourceSecretVersionDelete` in
  [secret_version.go v6.63.0](https://github.com/hashicorp/terraform-provider-aws/blob/v6.63.0/internal/service/secretsmanager/secret_version.go))
- In the same source, `secret_string_wo` conflicts with `secret_string` and is `RequiredWith`
  `secret_string_wo_version`, so the write-only value has to be present on every plan once the
  version number is set. Switching an existing version from `secret_string` to `secret_string_wo`
  with the same value is an in-place update; a different value, or a bumped `_wo_version`, replaces
  the version (a new `PutSecretValue`).

### Secrets Manager and the AWS CLI

- `PutSecretValue` without `VersionStages` moves `AWSCURRENT` to the new version and `AWSPREVIOUS`
  to the old one, so the prior key stays one label away. Secrets Manager keeps the latest 100
  versions. AWS warns that shell history can leak a value typed on the command line.
  ([PutSecretValue](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_PutSecretValue.html))
- The CLI reads any parameter from a file with `file://`, an absolute path giving three slashes
  ([loading parameters from a file](https://docs.aws.amazon.com/cli/latest/userguide/cli-usage-parameters-file.html)).
  `--secret-string file:///dev/stdin` therefore takes a piped value without it touching argv or
  history.

### App Runner

- "App Runner only pulls secrets and parameters during deployment." A changed value is not picked up
  until the service is redeployed.
  ([referencing environment variables](https://docs.aws.amazon.com/apprunner/latest/dg/env-variable.html))
- `StartDeployment` redeploys the latest image and starts new instances
  ([API](https://docs.aws.amazon.com/apprunner/latest/api/API_StartDeployment.html)). This service
  also auto-deploys on every image push to its ECR tag (`terraform/apprunner.tf`), so the next CI
  deploy picks up a new key as well.
- Because the service references the secret by ARN, changing the value through Terraform also leaves
  App Runner's configuration untouched. Rotation needs a redeploy under every option below. Today's
  rotation only redeploys because `APPLE_KEY_ID`, a plain env var, changes in the same apply.
- A failed App Runner action "doesn't mean that your App Runner service is down"; the running version
  keeps serving ([architecture](https://docs.aws.amazon.com/apprunner/latest/dg/architecture.html)).
- App Runner "is no longer open to new customers"; existing ones keep using it
  ([availability change](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html)).

### 1Password

- `op run` resolves `op://` references from the environment or an `--env-file` and hands the values
  to the child process as environment variables, masking them in its stdout and stderr by default.
  1Password warns that other processes of the same user can read that environment.
  ([op run](https://www.1password.dev/cli/reference/commands/run/),
  [secrets as environment variables](https://www.1password.dev/cli/secrets-environment-variables/))
- A file attachment is addressed as `op://vault/item/[section/]file-name`
  ([secret reference syntax](https://www.1password.dev/cli/secret-reference-syntax/)).
- The Terraform provider `1Password/onepassword` (v3.3.1 latest) authenticates with a service account
  token (`OP_SERVICE_ACCOUNT_TOKEN`), a Connect server (`OP_CONNECT_HOST`, `OP_CONNECT_TOKEN`), or the
  desktop app (`account`, biometric unlock), which the docs say needs the latest desktop beta and its
  "Integrate with 1Password SDKs" setting. It does not need the CLI.
  ([provider docs](https://www.1password.dev/terraform/))
- The provider's `onepassword_item` data source is a normal data source, so its values go to state.
  An ephemeral `onepassword_item` (v3.2.0+) retrieves values "without storing them in Terraform
  state", including file attachment `content`.
  ([changelog](https://github.com/1Password/terraform-provider-onepassword/blob/main/CHANGELOG.md),
  [ephemeral item](https://github.com/1Password/terraform-provider-onepassword/blob/main/docs/ephemeral-resources/item.md))

### This repo

- An empty `APPLE_PRIVATE_KEY` makes `buildSocialProviders` skip Apple silently
  (`src/utils/socialProviders.ts`). A malformed one throws at boot (`src/utils/appleClientSecret.ts`).
- `terraform/t4g.tfplan`, a saved plan from 2026-10-13, sits untracked in the checkout and is not
  covered by `.gitignore` (which lists `*.tfstate` and `*.tfvars`, not `*.tfplan`). Per the plan docs
  above it carries every secret of that plan in cleartext. It was not opened for this note.
- `apprunner.tf` says secrets are "Resolved at instance start"; the AWS docs say at deployment.
  `secrets.tf` already says deployment.

## Options

**A. Value outside Terraform.** Terraform keeps `aws_secretsmanager_secret`, the ARN in
`runtime_environment_secrets` and the IAM grant, and never writes the value. The existing version
leaves state through `removed { from = aws_secretsmanager_secret_version.apple_private_key
lifecycle { destroy = false } }`; even a plain destroy would leave the `AWSCURRENT` value in place. The
value is set once and on rotation with
`op read "op://…" | aws secretsmanager put-secret-value --secret-id <name> --secret-string file:///dev/stdin`,
then `aws apprunner start-deployment`. A plan-time check survives as an ephemeral
`aws_secretsmanager_secret_version` with a postcondition on `self.secret_string` (PEM header), which
reads the live value on every plan and stores nothing.

**B. `op run` wrapper.** A committed env file maps `TF_VAR_apple_private_key=op://…`, and every
command becomes `op run --env-file terraform/op.env -- terraform plan`. Nothing changes in Terraform.
The key still lands in state and in any saved plan. Adding `ephemeral = true` to the variable and
moving the resource to `secret_string_wo` keeps it out of both, at the cost of supplying it on every
plan and apply, saved plans included.

**C. 1Password Terraform provider.** The `onepassword_item` data source puts the key in state. The
ephemeral `onepassword_item` feeding `secret_string_wo` does not, and Terraform fetches the key
itself on each run. It needs desktop-app auth (Touch ID per run, beta app per the docs) or a service
account token, which is one more secret to keep on the Mac.

|                       | A. Outside Terraform                                              | B. `op run` + `TF_VAR`                      | B'. `op run` + ephemeral var + `_wo`                             | C'. 1Password provider, ephemeral + `_wo` |
| --------------------- | ----------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------- |
| Key in tfstate        | No (backups made before the switch still hold it)                 | Yes                                         | No                                                               | No (data source variant: yes)             |
| Key in saved plan     | No                                                                | Yes                                         | No                                                               | No                                        |
| Each plan/apply       | Nothing; AWS read for the check                                   | `op run` prefix, 1Password unlock           | `op run` prefix on plan and apply                                | 1Password unlock (or token)               |
| Rotation              | `op read \| put-secret-value`, `start-deployment`                 | Update 1Password, apply, `start-deployment` | Update 1Password, bump `_wo_version`, apply, `start-deployment`  | Same as B'                                |
| New dependency        | None                                                              | `op` CLI in the apply path                  | `op` CLI in the apply path                                       | New provider, beta app or token           |
| Empty value           | Plan fails: no `AWSCURRENT` version to read                       | Precondition catches it                     | `RequiredWith` and precondition catch it                         | Provider read fails                       |
| Malformed key         | Postcondition catches it at plan                                  | Applies, backend refuses to boot            | Applies, backend refuses to boot unless a precondition parses it | Same as B'                                |
| Value drift           | Terraform never sees AWS-side edits                               | Terraform overwrites them                   | Invisible until `_wo_version` bumps                              | Same as B'                                |
| First creation (APNs) | Two steps: create secret, put value, then wire it into App Runner | One apply                                   | One apply                                                        | One apply                                 |

Under every option App Runner keeps serving the old deployment if a new one fails to resolve its
secret, and a changed value needs a redeploy.

## Recommendation

Use **A** for both keys, with an ephemeral-read postcondition as the plan-time check.

- It is the only option where `terraform apply` neither asks for the keys nor reaches into
  1Password. B, B' and C' only automate the asking.
- The keys leave state and plans without new tooling in the apply path. B keeps them in state; B'
  and C' fix that but bind every plan to 1Password.
- Rotation already needs a manual `start-deployment` under every option, and these keys rarely
  rotate: Sign in with Apple keys do not expire, and the backend signs its own short-lived secrets.
  Two documented commands per rotation is less ceremony than an `op run` prefix on every plan.
- The ephemeral postcondition keeps today's "fail at plan, not at boot" guarantee and adds a format
  check the variable-based precondition never had.

Costs to accept:

- Terraform no longer notices an AWS-side change to the value.
- The APNs secret needs a two-step first rollout, because App Runner cannot deploy against a secret
  with no version and a plan cannot read a secret it has not yet created. A switch variable that
  wires the secret into App Runner, flipped after `put-secret-value`, handles it.
- The Apple key stays in `terraform.tfstate.backup` and the timestamped backup until those are
  deleted, and in `terraform/t4g.tfplan`. Removing it from state does not scrub them.

Follow-ups for the implementation ticket: add `*.tfplan` to `.gitignore` and delete the stale plan,
keep the four-ids precondition when the version resource goes, drop the version from App Runner's
`depends_on`, and fix the "Resolved at instance start" comment.
