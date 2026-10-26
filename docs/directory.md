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
and keeps every other directory row. It ends nobody: people left in no group stay employed until
someone ends them. The turn-off dialog and Delete all directory
data are T-514.

## Who ends an Employment

While the stored toggle is on, on any plan, `syncEmployment` opens Employments and never ends them.
Removing someone from their last group, revoking an org-admin grant, Change manager and group
deletion only remove links: the person stays employed in no group, and removing the last group no
longer revokes their admin row. Their pending requests and bookings after today in that group are
still cancelled. Nobody is notified. Turning the directory off brings the derived rule back for
each person's next link change; it ends nobody at the switch.

People in no group show on Team attendance to org admins only, as before. The directory list marks
them with `noGroup` for the owner and org admins (`noGroupFilter` says the rows carry it), and the
web offers a No group filter from it. A person without an account is always in no group.

### End employment

`POST /api/employment/{employmentId}/end` with `{ endedOn }`, today or earlier in the
organization's zone. In a Directory organization the End act cell decides (Owner, HR and Org admin
by default; roles count only while the directory is on); elsewhere the owner and org admins. Never
plan-gated. A live account, a Deleted account and a person without an account all end; the owner's
own Employment is 409 `OWNER_EMPLOYMENT`, and a group's manager 409 `MANAGES_GROUP`.

One transaction (`endLockedEmployment` in `src/services/employment/endEmploymentServices.ts`)
leaves every group, clears approver slots, drops the admin row, cancels bookings, stamps the end,
ends Directory roles and clears Reports to on every open record that names the person, writing a
Card history entry (`fields: ["reportsTo"]`) per record with the Audience the End cell credited.
Ended records keep theirs. Erase runs the same ending first.

`GET /api/directory/{organizationId}/people/{employmentId}/end-preview` feeds the dialog: today,
the spell start, the suggested date (a Leaving date of today or earlier, else today), the people
whose Reports to is cleared, the groups left and managed, the booked days cancelled, the admin row
and the roles. The profile's `actions` says which of End, Export and Erase the viewer gets; Export
and Erase stay with the owner and org admins.

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
- Ending an Employment (End employment, and `syncEmployment` outside the directory) and deleting an
  account remove its roles in the same transaction. A rejoin is a new Employment, so it starts without them.
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
- `image` is the Account picture and `photoUrl` the small Profile photo. The web shows the Profile
  photo, then the Account picture, then initials. No leave or attendance status appears on any
  directory route.

Refusals: 404 `ORGANIZATION_NOT_FOUND`, 409 `DIRECTORY_OFF`, 403 `NOT_IN_DIRECTORY` for a viewer
who is not the owner, an org admin or one of the organization's open people, and 404
`PERSON_NOT_FOUND` for a record out of reach or in another organization.

## Editing a profile

Decisions: fenro T-473 (the fields), T-477 (profile history), T-483 (start date), T-479 (display
strings for the phone), T-500 and T-502 (these builds).

`PATCH /api/directory/{organizationId}/people/{employmentId}` writes the Card, Work contact and Job
fields of one Employment, open or ended. In the body, a value sets a field, `null` clears it and a
missing key leaves it alone. Each Section in the body needs a write cell for the caller, resolved
the same way reads are. The profile lives in `directory_profiles`, one row per Employment, created
on the first write; a missing row reads as an empty profile.

| Section      | Field              | Rule                                                                                |
| ------------ | ------------------ | ----------------------------------------------------------------------------------- |
| Card         | Name               | Only without a bound, open account: no account, an ended spell or a Deleted account |
| Card         | Job title          | 1 to 100 characters, trimmed                                                        |
| Card         | Reports to         | Another open Employment of the organization, never the person's own                 |
| Work contact | Work email         | Up to 254 characters, stored lowercase, never synced with the sign-in email         |
| Work contact | Work phone         | One number in international form, no extension, stored in E.164                     |
| Job          | Legal name         | 1 to 200 characters                                                                 |
| Job          | Employee number    | 1 to 50 characters, unique ignoring case among the open Employments                 |
| Job          | Start date         | Never filled in from the spell; the web shows the spell start as a hint             |
| Job          | Leaving date       | Informational, ends nothing                                                         |
| Job          | Probation end date | Not before the start date; employees only                                           |
| Job          | Contract type      | Permanent, fixed-term, apprenticeship, internship, other; employees only            |
| Job          | Working time       | Full-time or part-time; employees only                                              |

The name writes the Employment's own copy. The directory shows that copy on every record except
an open one whose account is bound and not deleted, and the name helper shows a Deleted account's
copy everywhere else. A rename stamps the user row, so a phone pulls the new name. The sign-in
email is not editable here.

Setting any value needs the directory plan (402 `PLAN_LIMIT`); a body that only clears works on
every plan, so a lapsed organization can still correct and remove.

Reports to grants nothing. Erasing the person it names clears it everywhere, through the foreign
key. Ending that Employment clears it on open records (T-507).

Refusals: 404 `PERSON_NOT_FOUND`, 403 `SECTION_NOT_WRITABLE`, 403 `NAME_FROM_ACCOUNT`, 402,
422 `EMPLOYEES_ONLY`, `PROBATION_BEFORE_START`, `REPORTS_TO_NOT_FOUND`, `REPORTS_TO_SELF`,
`INVALID_PHONE`, and 409 `EMPLOYEE_NUMBER_TAKEN`.

### Phones and countries

The API parses phones with `libphonenumber-js` and refuses an invalid one (422 `INVALID_PHONE`).
Every phone in a response is `{ e164, display, country }`, and every country is `{ code, name }`,
named in the caller's language: `?language=en|cs`, else the stored setting, else English. The iPhone
app has no phone library and Hermes no `Intl.DisplayNames`, so it shows these strings as sent.

A caller who writes Work contact also gets `phoneCountryDefault`, where the edit form's phone
country starts: the Location's country, then the interface language (Czech gives CZ, English
none). `phoneCountryDefault` in `src/services/directory/contactFormat.ts` holds the rule.

Colleagues read Work contact and never the sign-in email; External workers read neither under the
product default.

### Profile history

Each write adds one `directory_profile_history` row per Section it changed: the actor, the
Employment, the Section, the names of the fields whose value changed and the Audience whose cell
granted the write. A rename counts as a Card change. No row ever holds a value. A write that changes
nothing adds nothing.

`GET /api/directory/{organizationId}/people/{employmentId}/history` serves it, newest first, to the
owner, org admins and HR (403 `HISTORY_DENIED` otherwise). Rows go with their Employment, so Erase
removes them.

The Person export carries each spell's Card, Work contact and Job fields under
`employments[].profile` and the history under `profileHistory`; the Organization export does the
same for people without an account.

## Profile photo

Decisions: fenro T-471 (where it shows), T-476 (storage and serving), T-477 (the Lambda's KMS
rights, no biometrics) and T-505 (this build).

The Profile photo is the organization's own picture of one Employment. It comes from an upload only,
never from the Account picture, and shows on directory pages only: the card and the profile. Every
other screen (calendars, reports, Team attendance, the phone's `users` sync) keeps the Account
picture. A viewer whose Photo cell is none gets the Account picture, then initials.

Writing it follows the Photo row: by default the person, HR and org admins, and only the admin
columns while no account is bound. Setting a photo needs the directory plan (402); removing works on
every plan.

1. `POST /api/directory/{organizationId}/people/{employmentId}/photo` with `{ contentType, size }`
   (PNG, JPEG, WebP or HEIC, at most 10 MB) adds a `directory_photos` row in `UPLOADING` and
   answers where the bytes go: a presigned POST to `incoming/<photoId>` of the organization-data
   bucket, or the disk store's signed PUT. Any earlier upload of the same Employment that has not
   settled is dropped.
2. The `attachment-processor` Lambda (or the disk store, in-process) decodes the image and writes a
   small (256 px on the long edge) and a full (1024 px) JPEG without EXIF or GPS metadata under
   `photos/<organizationId>/<employmentId>/<photoId>/`. It only decodes and resizes; no image is
   ever matched, recognised or sent to a vision service.
3. The Lambda reports to `POST /api/directory/photos/processed`, signed like its attachment
   reports. A `READY` photo replaces the previous one in the same transaction, and the old folder is
   deleted after the commit. The web polls
   `GET /api/directory/{organizationId}/people/{employmentId}/photo/{photoId}` meanwhile.

`DELETE /api/directory/{organizationId}/people/{employmentId}/photo` removes the photo and both
sizes. Erase deletes every photo folder of the person's Employments, and deleting the organization
deletes `photos/<organizationId>/`. Versioning keeps the old objects 7 days, like the backups.
Setting and removing each add a Photo row to the profile history, with the field `photo`.

Serving: list rows carry `photoUrl` (small) and the profile `sections.photo.photo` (`smallUrl`,
`fullUrl`), both only for viewers who read Photo. The links are presigned with the start of the
current hour as their signing date and live two hours, so every response in an hour hands out the
same URL and browsers and the phone can cache the image. On S3 the link is also bound to the App
Runner role's temporary credentials and stops working when they expire, so a cached link can die
early; the next response signs a fresh one.

The Person export carries each spell's full photo as `profile-photos/<employmentId>.jpg`, named in
`employments[].photo`.
