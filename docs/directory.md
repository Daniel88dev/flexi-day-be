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

A row added to the default later lands in every stored copy with its default value without a
migration: `readPermissionCells` fills any cell a copy lacks from the default, and the first change
to that cell stores it. A stored cell always wins, so changing an existing default cell leaves every
copy alone.

### Editing the table

Decisions: fenro T-472 (floors, roles) and T-477 (Permission history). Rules in
`src/services/directory/permissionTable.ts`, routes in `directoryPermissionServices.ts`.

- `GET /api/directory/{organizationId}/permissions` returns every cell with `fixed` and the
  `options` the owner may set. The owner, org admins and HR read it (403 `PERMISSIONS_DENIED`).
- `PATCH` the same path with `{ row, audience, value }` changes one cell. Owner only (403
  `OWNER_ONLY`). 422 `CELL_FIXED` for the Owner column and Self on Card and Job, 422
  `VALUE_NOT_OFFERED` for write on Colleague or External worker, none on Self, or a value of the
  other kind, 422 `NO_SUCH_CELL` where the table has no cell.
- While the plan is lapsed, a narrowing (a lower level, or allowed to no) goes through and a
  widening is 402 `PLAN_LIMIT`.

### Directory roles

HR and Leadership live in `directory_role_assignments`, one row per Employment and role. Only an
open Employment with a live account holds one: setting a role on an account-less, ended or Deleted
account's Employment is 422 `NO_ACCOUNT`, `EMPLOYMENT_ENDED` or `ACCOUNT_DELETED`. Being an org
admin brings neither.

- `GET /api/directory/{organizationId}/roles` lists every eligible person with their roles, for the
  owner, org admins and HR. `PUT .../roles/{employmentId}` with `{ roles }` sets them, owner only.
  Adding a role needs the directory plan; removing one never does.
- Ending an Employment (`syncEmployment`, End employment) and deleting an account remove its roles
  in the same transaction. A rejoin is a new Employment, so it starts without them.
- `loadDirectoryViewer` reads the viewer's roles from their open Employment, so the resolver credits
  the HR and Leadership Audiences, and the profile's `account.directoryRoles` shows them.

### Permission history

`directory_permission_history` records every cell change (row, Audience, value before and after)
and every role assigned, removed or ended (role, Employment, held before and after, and the reason:
`OWNER`, `EMPLOYMENT_ENDED` or `ACCOUNT_DELETED`), with the actor and time. Setting a cell to its
own value adds nothing. Rows go only with the organization; erasing a person sets their Employment
reference to null. `GET /api/directory/{organizationId}/permissions/history` serves it newest first
to the owner, org admins and HR.

## Who learns what

- `GET /api/organization/directory`: owner and org admins, the state and live Employment counts.
- `GET /api/directory/organizations`: any signed-in user, the organizations they own, administer
  or hold an open Employment in, with whether the directory is on there and whether the plan
  passes. The web's People section reads it.
- The support organization detail carries the state, agreement versions and counts, never a Profile
  field (`docs/invariants.md`, platform-support surface).

## Reading the directory

Decisions: fenro T-472 (the table and its floors), T-478 (the pages) and T-499 (this build).

`loadDirectoryViewer(viewerUserId, organizationId)` in `src/services/directory/directoryViewer.ts`
reads the viewer's standing and the organization's cells once. Its `accessTo(record)` calls the pure
`resolveAccess` in `permissionResolver.ts`, which every directory read and write goes through.

Audiences that credit a viewer on a record:

- **Owner**: the organization's owner.
- **Self**: the record is the viewer's own open Employment.
- **Colleague** or **External worker**: the viewer holds an open Employment of that type. Both
  credit on the viewer's own record too.
- **Group admin**: the record's user is a plain member of a live group the viewer manages or holds
  admin access in. A group's manager is never one of its members, and a person without an account
  is outside every Group admin's reach.
- **HR** and **Leadership**: directory roles on the viewer's open Employment (T-506 stores them;
  until then nobody holds one).
- **Org admin**: a delegated org-admin grant.

The widest cell of those audiences wins per Section. The floors hold whatever the stored cells say:
the Owner writes every Section, Self reads every Section of their own open record, and Colleague
and External worker never get more than read. An ended record counts only the Owner, Org admin
and HR audiences, which is also who sees the Former list.

A viewer reaches a record only while they read its Card: without it the person is missing from
the list and their profile is a 404.

Routes, all read-only and open through a lapse:

- `GET /api/directory/{organizationId}/people`: open Employments in reach, by name.
- `GET /api/directory/{organizationId}/former`: ended spells in reach, latest end first; 403
  `FORMER_LIST_DENIED` for anyone but the owner, org admins and HR.
- `GET /api/directory/{organizationId}/people/{employmentId}`: the profile, with a key in
  `sections` only for each Section the viewer reads. Spell dates sit in `job`.

What else a viewer learns:

- The External worker marker goes to everyone in reach. No account, Account deleted and Rejoined
  go to the owner, org admins and HR.
- `account` (status, sign-in email, directory roles) goes to the owner, org admins, HR and the
  person.
- `image` is the Account picture, so the web falls back from the Profile photo to it, then to
  initials. No leave or attendance status appears on any directory route.

Refusals: 404 `ORGANIZATION_NOT_FOUND`, 409 `DIRECTORY_OFF`, 403 `NOT_IN_DIRECTORY` for a viewer
who is not the owner, an org admin or one of the organization's open people, and 404
`PERSON_NOT_FOUND` for a record out of reach or in another organization.

## Editing a profile

Decisions: fenro T-473 (the fields), T-477 (profile history), T-483 (start date) and T-500 (this
build).

`PATCH /api/directory/{organizationId}/people/{employmentId}` writes the Card and Job fields of one
Employment, open or ended. In the body, a value sets a field, `null` clears it and a missing key
leaves it alone. Each Section in the body needs a write cell for the caller, resolved the same way
reads are. The profile lives in `directory_profiles`, one row per Employment, created on the first
write; a missing row reads as an empty profile.

| Section | Field              | Rule                                                                                |
| ------- | ------------------ | ----------------------------------------------------------------------------------- |
| Card    | Name               | Only without a bound, open account: no account, an ended spell or a Deleted account |
| Card    | Job title          | 1 to 100 characters, trimmed                                                        |
| Card    | Reports to         | Another open Employment of the organization, never the person's own                 |
| Job     | Legal name         | 1 to 200 characters                                                                 |
| Job     | Employee number    | 1 to 50 characters, unique ignoring case among the open Employments                 |
| Job     | Start date         | Never filled in from the spell; the web shows the spell start as a hint             |
| Job     | Leaving date       | Informational, ends nothing                                                         |
| Job     | Probation end date | Not before the start date; employees only                                           |
| Job     | Contract type      | Permanent, fixed-term, apprenticeship, internship, other; employees only            |
| Job     | Working time       | Full-time or part-time; employees only                                              |

The name writes the Employment's own copy. The directory shows that copy on every record except
an open one whose account is bound and not deleted, and the name helper shows a Deleted account's
copy everywhere else. A rename stamps the user row, so a phone pulls the new name. The sign-in
email is not editable here.

Setting any value needs the directory plan (402 `PLAN_LIMIT`); a body that only clears works on
every plan, so a lapsed organization can still correct and remove.

Reports to grants nothing. Erasing the person it names clears it everywhere, through the foreign
key. Ending that Employment clears it on open records (T-507).

Refusals: 404 `PERSON_NOT_FOUND`, 403 `SECTION_NOT_WRITABLE`, 403 `NAME_FROM_ACCOUNT`, 402,
422 `EMPLOYEES_ONLY`, `PROBATION_BEFORE_START`, `REPORTS_TO_NOT_FOUND`, `REPORTS_TO_SELF`, and 409
`EMPLOYEE_NUMBER_TAKEN`.

### Profile history

Each write adds one `directory_profile_history` row per Section it changed: the actor, the
Employment, the Section, the names of the fields whose value changed and the Audience whose cell
granted the write. A rename counts as a Card change. No row ever holds a value. A write that changes
nothing adds nothing.

`GET /api/directory/{organizationId}/people/{employmentId}/history` serves it, newest first, to the
owner, org admins and HR (403 `HISTORY_DENIED` otherwise). Rows go with their Employment, so Erase
removes them.

The Person export carries each spell's Card and Job fields under `employments[].profile` and the
history under `profileHistory`; the Organization export does the same for people without an
account.
