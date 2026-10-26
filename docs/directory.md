# People directory

The directory is an opt-in setting of one organization. Only its owner turns it on, and doing so
accepts the directory agreement. Decisions behind this page: fenro T-472, T-475, T-481 and T-483.

## Turning it on

`POST /api/organization/directory/enable` with the agreement version the owner was shown. One
transaction writes three things and nothing per Employment:

- the `organization_directory_settings` row: on, by whom, when;
- a `directory_agreement_acceptances` row for the current version;
- the organization's copy of the product default Permission table, one
  `directory_permission_cells` row per cell, fixed cells included.

The copy never overwrites a stored cell. A re-enable therefore brings back the organization's own
table and adds only cells the product gained in the meantime, with their defaults.

Refusals, in order: 403 `OWNER_ONLY` for anyone but the owner, 402 (`reason: PLAN_LIMIT`, `code:
DIRECTORY_PLAN_REQUIRED`) when the plan fails the gate, 409 `DIRECTORY_ALREADY_ON`, and 409
`AGREEMENT_VERSION_STALE` when the version sent is not the current one.

## Turning it off

`POST /api/organization/directory/disable`, owner only, on every plan. It updates the settings row
and keeps every other directory row. It ends nobody. The turn-off dialog and Delete all directory
data are T-514.

## The plan gate

`assertDirectoryWritable` in `src/services/billing/guards.ts` passes Enterprise (paid, trialing or
in grace) and an active Enterprise or Custom override. Free and Pro fail in every form. It resolves
at read time, so a lapse writes nothing. Turning on and adding directory data call it; removing data
never does.

A Directory organization stays one through a lapse: the stored toggle decides, not the plan.

## The agreement

`DIRECTORY_AGREEMENT_VERSION` in `src/services/directory/directoryAgreement.ts` is the version an
owner accepts today. Its text is the web's `/directory-agreement/` page. Raising the constant sets
`agreement.newVersionReady` for the owner while the directory is on. The web shows the owner a
banner, and `POST /api/organization/directory/agreement` stores the new acceptance. Nothing pauses
in the meantime.

## The Permission table

The product default lives in code, `DIRECTORY_PERMISSION_DEFAULTS` in
`src/services/directory/permissionDefaults.ts`: six Section rows (Card, Photo, Work contact, Job,
Contact, Personal) and five act rows (Create account-less person, Send directory invite, Change
worker type, End an Employment, Manage departments and locations), against eight Audiences. A cell
the table has no entry for has no row. Which cells are fixed is part of the default, not stored.

A row added to the default later lands in every stored copy through a migration that inserts its
cells for each organization that has a copy, and in later enables through the copy itself.

## Who learns what

- `GET /api/organization/directory`: owner and org admins, the state and live Employment counts.
- `GET /api/directory/organizations`: any signed-in user, the organizations they own, administer
  or hold an open Employment in, with whether the directory is on there and whether the plan
  passes. The web's People section reads it.
- The support organization detail carries the state, agreement versions and counts, never a Profile
  field (`docs/invariants.md`, platform-support surface).
