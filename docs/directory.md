# People directory

The directory is an opt-in setting of one organization. Only its owner turns it on, and doing so
accepts the directory agreement. Decisions behind this page: fenro T-472, T-475, T-481 and T-483.
How Employments change in a Directory organization (spells, records without an account, no ending
on link loss) is in [ADR 0008](adr/0008-employment-spells-and-directory-records.md).

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

### The members' notice

With `tellMembers: true` in the body, the enable plans one `directory_enabled` Notification per
bound open Employment inside its transaction and sends them after the commit
(`src/services/directory/directoryEnabledNotice.ts`): "Acme turned on the people directory. Check
your profile and add your contact details." It is in-app and pushed passively, never mailed, in the
reader's language, and links to the reader's own profile (`/directory/person/?organizationId=…&employmentId=…`).
The owner who turned it on gets one too. Deleted accounts, people without an account and leavers
get nothing. An
absent `tellMembers` sends nothing. The web's tickbox is on at the first enable (no `enabledAt`
yet) and off at later ones.

### The setup checklist

`GET /api/directory/{org}/checklist`, for the owner, org admins and HR (403 `CHECKLIST_DENIED`
otherwise). Four items tick themselves from the data: a Department that is not archived, a Location
that is not archived, HR held on an open Employment with a live account, and a job title on an open
Profile. Assign HR and the "Review who sees what" link go to the owner only. No emails, no
reminders.

`hidden` is true once every item the viewer sees is done, or once anyone clicked Hide
(`POST .../checklist/hide`, every plan). Hide stamps `organization_directory_settings.checklist_hidden_at`;
it counts only while it is at or after `enabled_at`, so a re-enable shows the checklist again with
the ticks the data still earns.

## Turning it off

`POST /api/organization/directory/disable`, owner only, on every plan. It updates the settings row
and keeps every other directory row, Permission table and Directory roles included. Decisions:
fenro T-483 and T-514.

- It ends nobody. From then on each person's next link change follows the derived rule again.
- Open Employments that no link holds stay open until an admin ends them: people without an
  account, and account holders in no group with no admin grant. `GET /api/employment/list` marks
  them `noLink: true` for org admins (`unlinkedOpenEmploymentIds` in `employmentServices.ts`). The
  web's turn-off dialog lists them, and the People card on `/organization` offers End employment
  on those rows and Erase on rows without an account.
- It revokes open directory invites that name no group. Invites that name a group stay valid and
  still claim.
- Directory roles stay stored and grant nothing, since the directory routes answer 409
  `DIRECTORY_OFF`. The External worker type keeps its effects.
- Retention keeps running, so its controls stay open to the owner and org admins: setting and
  lifting a hold, reading and changing Retention periods and their preview, and the Read log. Those
  routes load the viewer with `whileOff` (`loadDirectoryViewer`), which lets those two through
  without Directory roles and still answers 409 `DIRECTORY_OFF` to everyone else.

## Delete all directory data

`POST /api/organization/directory/delete-all` `{ confirmName }`, owner only, on every plan, only
while the directory is off (409 `DIRECTORY_ON`), and only with the organization's name typed (422
`NAME_MISMATCH`, compared like Erase compares a person's name). One transaction in
`deleteAllDirectoryData` (`directoryDeleteAllServices.ts`):

| Removed                                                                                    | Kept                                                          |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `directory_profiles`, `directory_sensitive_profiles`                                       | Employments with an account: name and email copy, type, dates |
| `directory_photos` rows, then `photos/<org>/` after the commit                             | `directory_agreement_acceptances`                             |
| `directory_departments`, `directory_locations`                                             | `read_log`, until its own 12-month purge                      |
| `directory_role_assignments`, `directory_permission_cells`, `directory_permission_history` | `directory_profile_history` of Employments with an account    |
| `directory_retention_periods`, `directory_retention_holds`                                 | the settings row, stamped `data_deleted_at` and `_by_user_id` |
| the notice texts and the checklist's Hide stamp on the settings row                        |                                                               |
| every Person export row of the organization and its file                                   | Organization exports, the owner's return copy                 |
| every Employment without an account, open or ended, with its invites and history           |                                                               |

Retention settings, holds, the notice text and Person exports are not named in T-483. They go
because they are directory configuration or copies of Profile fields, and a later enable starts
from the product defaults for all of them, as it does for the Permission table. Organization
exports stay: the owner may take the return copy before deleting, and it expires on its own after
7 days.

## Turning it back on

The enable route above. The plan gate applies and a new acceptance row is stored each time. The
stored Permission table comes back as it was, cells the product added since land with their
defaults, and after a Delete all the default is copied fresh. Directory roles come back. Retention
clocks are untouched, and open Employments fall under the admin-only ending again.

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
Ended records keep theirs. It then empties every Section whose [Retention period](#retention) is
"at end", and the photo folder goes after the commit. Erase runs the same ending first.

`GET /api/directory/{organizationId}/people/{employmentId}/end-preview` feeds the dialog: today,
the spell start, the suggested date (a Leaving date of today or earlier, else today), the people
whose Reports to is cleared, the groups left and managed, the booked days cancelled, the admin row,
the roles, and `atEndSections`, the "at end" Sections that hold something. The profile's `actions` says which of End, Export and Erase the viewer gets; Export
and Erase stay with the owner and org admins.

## The plan gate

`assertDirectoryWritable` in `src/services/billing/guards.ts` passes Enterprise (paid, trialing or
in grace) and an active Enterprise or Custom override. Free and Pro fail in every form. It resolves
at read time, so a lapse writes nothing. Turning on and adding directory data call it; removing data
never does.

A Directory organization stays one through a lapse or a downgrade until the owner turns it off: the
stored toggle decides, not the plan.

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

**A new row ships with a migration that inserts its default into every stored copy**
(`insert ... on conflict do nothing` for every organization holding cells). Until it runs,
`readPermissionCells` fills any cell a copy lacks from the default, so nothing breaks, and the
owner's next edit (`storeMissingCells` in `changePermissionCell`) or a re-enable stores every
missing cell at its default. Without the migration a later change to that row's default would
silently change every copy that never stored it, which is the override model T-472 rejected. A
stored cell always wins, so changing an existing default cell leaves every copy alone. The e2e
suite checks that every enabled organization's copy holds every product cell.

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
  `FORMER_LIST_DENIED` for anyone but the owner, org admins and HR. `startedAt` and `endedAt` are
  null for a viewer who doesn't read Job; the server still sorts by the end.
- `GET /api/directory/{organizationId}/people/{employmentId}`: the profile, with a key in
  `sections` only for each Section the viewer reads. Spell dates sit in `job`.

What else a viewer learns:

- The External worker marker goes to everyone in reach. No account, Account deleted and Rejoined
  go to the owner, org admins and HR.
- `account` (status, sign-in email, directory roles) goes to the owner, org admins, HR and the
  person.
- `user.id` is null on a record without an account, for every viewer, so the id can't tell a
  colleague who has no account; initials and colour still come keyed on the Employment.
- `image` is the Account picture and `photoUrl` the small Profile photo. The web shows the Profile
  photo, then the Account picture, then initials. No leave or attendance status appears on any
  directory route.

Refusals: 404 `ORGANIZATION_NOT_FOUND`, 409 `DIRECTORY_OFF`, 403 `NOT_IN_DIRECTORY` for a viewer
who is not the owner, an org admin or one of the organization's open people, and 404
`PERSON_NOT_FOUND` for a record out of reach or in another organization.

## Editing a profile

Decisions: fenro T-473 (the fields), T-477 (profile history), T-483 (start date), T-479 (display
strings for the phone), T-500, T-501 and T-502 (these builds).

`PATCH /api/directory/{organizationId}/people/{employmentId}` writes the Card, Work contact and Job
fields of one Employment, open or ended. In the body, a value sets a field, `null` clears it and a
missing key leaves it alone. Each Section in the body needs a write cell for the caller, resolved
the same way reads are. The profile lives in `directory_profiles`, one row per Employment, created
on the first write; a missing row reads as an empty profile.

| Section      | Field              | Rule                                                                                |
| ------------ | ------------------ | ----------------------------------------------------------------------------------- |
| Card         | Name               | Only without a bound, open account: no account, an ended spell or a Deleted account |
| Card         | Job title          | 1 to 100 characters, trimmed                                                        |
| Card         | Department         | An entry of the organization's Department list, not archived unless already held    |
| Card         | Location           | An entry of the organization's Location list, not archived unless already held      |
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
`INVALID_PHONE`, `ENTRY_NOT_FOUND`, `ENTRY_ARCHIVED`, and 409 `EMPLOYEE_NUMBER_TAKEN`.

### Adding a person without an account

Decisions: fenro T-470, T-471, T-472, T-478 and T-508 (this build).

`POST /api/directory/{organizationId}/people` opens an Employment with no account bound, holding
the person's name (required), worker type (`employee` or `external`), an optional email and the
Card fields job title, Department, Location and Reports to, under the same rules as the table
above. The answer is the new profile, which the web opens.

- **Who:** the Create account-less person act cell (Owner fixed, HR and Org admin by default),
  403 `CREATE_DENIED` otherwise. The act covers the name and the Card fields; it needs no Card
  write cell. It resolves on the record it creates, open and without an account, and no group
  admin reaches such a record, so the Group admin cell never credits. The list says
  `addPerson: true` to whoever holds the act.
- **Plan:** needs the directory plan, 402 `PLAN_LIMIT` on a lapsed organization.
- **Email:** unique among the organization's open Employments, bound, account-less and Deleted
  account copies alike, ignoring case: 409 `EMPLOYMENT_EMAIL_TAKEN`. The check runs under
  `lockEmploymentEmail`, the lock join paths take before their own clash check, so the two can't
  both find the address free. An ended Employment frees its address. The dialog's blur check is
  `POST .../people/email-check` with the email in the body, answering `{ available }` to act
  holders only.
- **History:** one Card entry with `name` and every Card field set, and the Audience that credited
  the act.
- **Afterwards:** the person is in no group, so nobody books for them, gives them a quota or enters
  attendance, and they get no notifications and never count toward a seat cap. A join path whose
  account email matches is refused with 409 `ACCOUNTLESS_EMPLOYMENT_EMAIL`; only an invite binds
  (see below). "No account" shows to the owner, org admins and HR only. End, Erase and the
  Person export all take the record; Erase deletes that one Employment.

### The directory invite and the Claim

Decisions: fenro T-470, T-471, T-483, T-509 (this build) and T-529.

**Email.** `card.email` in `PATCH .../people/{employmentId}` sets, changes or clears the address of
an open record without an account, for whoever writes the Card. Same rule as Add person: unique
among the open Employments, ignoring case, under `lockEmploymentEmail`, 409
`EMPLOYMENT_EMAIL_TAKEN`. Setting needs the plan, clearing doesn't. A bound or ended record answers
422 `EMAIL_FROM_ACCOUNT`. The change writes a Card history entry with the field `email` and revokes
the record's open directory invite, because that went to the old address.

**Sending.** `POST .../people/{employmentId}/invite` with an optional `groupId`:

- **Who:** the Send directory invite act cell (Owner fixed, HR and Org admin by default), 403
  `INVITE_DENIED` otherwise. It resolves on the record, open and without an account, so Group admin
  never credits. The profile says `actions.invite`.
- **When:** an open record (409 `EMPLOYMENT_ENDED`) without an account (422 `HAS_ACCOUNT`) that has
  an email (422 `NO_EMAIL`), on the directory plan (402). A named group must be a live group of the
  organization (422 `GROUP_NOT_FOUND`), writable and with a free seat.
- **What:** an `invite_link` row with `employment_id` set and `group_id` null unless a group was
  named, bound to the address, valid 14 days. Sending again revokes the open one. The
  `directory-invite` email names the organization, never a group, and carries the link only.
- **Marker:** `INVITE_SENT` while the invite is open, to the owner, org admins and HR.

**Claiming.** Every redemption, by code, link or sign-up with invite, runs the Claim inside
`redeemInvite` before any group join (`claimEmployment` in
`src/services/employment/claimEmployment.ts`):

- The target is the directory invite's Employment, or for any other invite the open account-less
  Employment holding the invited address. An invite with no address (older than email invites)
  never claims.
- The account is written onto the row with its name and email; from then on the copy follows the
  account (the `employments_follow_user` trigger), and the record shows the account's name.
- An account that already has an open Employment in the organization is refused with 409
  `ALREADY_EMPLOYED`, and nothing is written. The admin resolves the duplicate.
- A directory invite whose person has ended, been bound or changed address answers 410
  `INVITE_REVOKED`.
- Signing up with a matching email and no invite never binds. Org-admin grants and new managers
  still get 409 `ACCOUNTLESS_EMPLOYMENT_EMAIL`.
- The Claim is never plan-gated and works while the directory is off. Turning the directory off
  revokes open directory invites that name no group.
- The invite preview answers `organizationName` and `personName`, so the sign-up form fills the name
  in. A directory invite that names no group answers `groupId: null` everywhere, and its join
  responses are `{ groupId: null, claimed }`.

### Change worker type

Decisions: fenro T-470 (what applies to an External worker), T-473 (what the change clears), T-483
(it waits for the directory), T-510 (this build).

`PUT /api/directory/{org}/people/{employmentId}/worker-type` with `{ type }`. The Change worker
type act cell decides, resolved on the record, and only open records change. It waits for the
directory (409 `DIRECTORY_OFF`) and is never plan-gated. Setting the type a record already has
changes nothing.

Changing to `external`, in one transaction:

- clears Contract type, Working time and Probation end date, and the whole Personal section;
- drops the required-time override;
- sets the person's allowances in the organization's groups to zero from this year on, creating
  the year's row where it is missing so the group defaults stop applying.

Profile history gets a JOB row and a PERSONAL row for what went, and a `CHANGE_WORKER_TYPE` row
with the field `type`. Changing back to `employee` restores nothing: the cleared fields start
empty and the allowances stay at zero until an admin sets them.

What follows from the type, whether the directory is on or off:

- Attendance: the clock read answers `active: false` and `externalWorker: true`. Clock-in, start
  break and entering a session answer 403 `reason: EXTERNAL_WORKER`; clock-out and end break still
  work, so a session open at the change can close. The month counts no required time, Team
  attendance leaves External workers out, and a required-time override is 422 `EXTERNAL_WORKER`.
- Allowances: joining a group and the yearly rollover open the year at zero with nothing carried
  over.
- Bookings: a booking, edit or approval of a type that draws on an allowance (Vacation, Home office,
  Sick day while the benefit is on) is 422 `EXTERNAL_WORKER_ALLOWANCE`, whatever the stored quota.
  Types that draw on none book as for employees.
- Group membership, calendars, reports, notifications, Birthday and seat caps work as for employees.

### Copy from previous spell

Decisions: fenro T-471 (a rejoin starts empty), T-473 (whole Sections, Personal skipped for
External workers), T-474 (only what retention left), T-478 (the banner and dialog), T-513 (this
build).

A new spell's profile starts empty. Its previous spell is the latest ended Employment of the
organization begun before it with the same user, or with the same email (case-insensitive) when
either spell has no account (`findPreviousSpell` in `previousSpellServices.ts`).

`GET /api/directory/{org}/people/{employmentId}/previous-spell` names the previous spell and gives
Contact, Personal and Photo a status each: `COPYABLE`, `REMOVED_ON` (a Retention purge emptied it,
with the day), `EMPTY`, `FILLED` (this spell already holds it) or `NOT_WRITABLE`. Personal is absent
on an External worker's spell. `POST .../previous-spell/copy` with `{ sections }` copies the chosen
Sections in one transaction:

- the owner, org admins and HR only (403 `COPY_DENIED`), with Write on each chosen Section of the
  new spell, on an open spell (409 `EMPLOYMENT_ENDED`), and 402 on a lapsed plan;
- a Section this spell holds is never overwritten (409 `SECTION_ALREADY_FILLED`), and one the
  previous spell no longer holds is refused (409 `SECTION_NOT_HELD`);
- Contact and Personal are opened and sealed again under the new row's context, never copied as
  ciphertext; the values never reach the caller, so no Read log row is written;
- the Profile photo's two files are written again under a new photo id in the new spell's folder,
  which the controller deletes if the transaction fails;
- each copied Section writes a profile history row with the fields that held a value.

Card, Work contact and Job never carry over. The profile's `actions.copyFromPreviousSpell` is true
while a Section is `COPYABLE` for the caller, and the web shows its banner from it.

### Departments and Locations

Decisions: fenro T-473 (the lists and the act row), T-478 (archived entries), T-501 (this build).

Each organization keeps its own Department list (`directory_departments`) and Location list
(`directory_locations`); a Location may carry an ISO 3166-1 alpha-2 country. A Profile holds at
most one entry of each, in `directory_profiles.department_id` and `location_id`. Neither list is
tied to groups, and a Location's country drives no holiday country, working days or attendance. It
only starts the phone picker, through `phoneCountryDefault`.

| Route                                                 | Who                     | Plan           |
| ----------------------------------------------------- | ----------------------- | -------------- |
| `GET /api/directory/{org}/departments\|locations`     | anyone in the directory | every plan     |
| `POST .../departments\|locations`                     | the act cell            | directory plan |
| `PATCH .../{entryId}` rename, archive, clear country  | the act cell            | every plan     |
| `PATCH .../{entryId}` restore, set a country          | the act cell            | directory plan |
| `DELETE .../{entryId}`, only while no record holds it | the act cell            | every plan     |

The act cell is the Manage departments and locations row of the Permission table: the owner always,
HR and org admins by default, Group admin and Leadership not. It has no record, so the service
resolves it on a synthetic open record (`canManageLists` in `directoryListServices.ts`). T-498
seeded the row in the product default, and a stored copy that lacks it reads it at the default,
so no organization needed a backfill.

Names are unique within a list, ignoring case, archived entries included (409 `NAME_TAKEN`). An
entry any record holds, open or former, can't be deleted (409 `ENTRY_IN_USE`), because the Card is
kept until erased; it is archived instead. An archived entry leaves the pickers and can't be given
to anyone new (422 `ENTRY_ARCHIVED`), while the records that hold it keep it and show it as "Name
(archived)". Directory list rows and the Card carry `department` and `location` as
`{ id, name, archived }`, and the Card's location adds its `country`. The directory filters by
both on the client, from the list rows. The Person export carries the entry names.

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
nothing adds nothing. A [Retention purge](#retention) writes `actor` RETENTION, with no person, no
Audience and every field of its Section.

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

## Sensitive sections

Decisions: fenro T-473 (the fields), T-477 (encryption and the Read log), T-478 (Show), T-474
(export) and T-504 (this build).

Contact and Personal are the Sensitive sections. They live in `directory_sensitive_profiles`, one
row per Employment, each Section one JSON value sealed under the organization's data key (see
[`field-encryption.md`](field-encryption.md)). An emptied Section stores null. Nothing in them is
searched, sorted or kept unique.

| Section  | Field                     | Rule                                                                                                                       |
| -------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Contact  | Private phone             | One number in international form, stored in E.164                                                                          |
| Contact  | Private email             | Up to 254 characters, stored lowercase                                                                                     |
| Contact  | Emergency contact 1 and 2 | A name (1 to 100) and a phone (E.164), both needed in a filled slot; no relation                                           |
| Personal | Home address              | Line 1, line 2, postal code (up to 16), city, region, ISO country; line 1, city and country needed once any part is filled |
| Personal | Date of birth             | From 1900-01-01 to today in the organization's time zone                                                                   |

Personal applies to employees only: the profile leaves it out on an External worker's record, and
Show and writes answer 422 `EMPLOYEES_ONLY`. Writes go through the profile `PATCH` as `contact`
and `personal`, with the same plan rule and profile history as the other Sections. Further
refusals: 422 `INVALID_COUNTRY`, `DATE_OF_BIRTH_OUT_OF_RANGE`.

### Show and the Read log

No profile or `PATCH` answer carries a Contact or Personal value, for anyone. The values come only
from `POST /api/directory/{organizationId}/people/{employmentId}/show/{contact|personal}`, for a
caller whose cell reads the Section (403 `SECTION_NOT_READABLE` otherwise). For anyone but the
person, each call writes one `read_log` row of kind `read`: reader, Employment, the Section, the
Audience whose cell granted it, the time, never a value. The person's own record writes none, in
any spell. The web holds an opened Section for the visit to that person, so the profile and the
edit page share one Show.

A record without an account has no subject user: its row has `subject_user_id` null and names the
Employment in `employment_ids`. Rows outlive Erase, because they hold no values.

`GET /api/directory/{organizationId}/read-log` lists reads and exports, newest first, with readers'
names, filterable by `employmentId` and `readerUserId`, to the owner and org admins (403
`READ_LOG_DENIED` otherwise, HR included). The nightly tick removes rows older than 12 months
(`runReadLogPurge`). The phone never shows the log.

The Person export carries each spell's `contact` and `personal` as stored, and `readLog` with the
date, kind, Sections and a purpose label taken from the Audience (HR administration, organization
administration, line management, leadership, owner), without readers. The Organization export does
the same for people without an account.

### The Art. 14 notice

Whoever writes Contact gets `sections.contact.notice` on the profile, shown under the emergency
contacts. The product default text is in `emergencyContactNotice.ts`, in English and Czech; the
legal wording is the owner's (T-496). The owner and org admins replace it per language through
`PUT /api/directory/{organizationId}/settings/general`; HR reads it. `{organization}` becomes the
organization's name and `{period}` names the organization's [Retention period](#retention) for
Contact (`retentionPeriodLabel` in `retentionPeriods.ts`).

## Retention

Each Section has a Retention period per organization, kept in `directory_retention_periods` (one
row per Section the owner or an org admin changed; a missing row reads as the product default in
`RETENTION_DEFAULTS`, `src/services/directory/retentionPeriods.ts`):

| Section      | Default      |
| ------------ | ------------ |
| Card         | until erased |
| Job          | until erased |
| Work contact | 30 days      |
| Contact      | 30 days      |
| Personal     | 3 years      |
| Photo        | 1 year       |

The list is at end, 30 days, 6 months, 1 year, 3 years, 5 years, 10 years, until erased, with no
caps and on every plan. `GET|PUT /api/directory/{organizationId}/settings/retention` reads (owner,
org admins, HR) and sets one Section (owner and org admins, 403 `SETTINGS_NOT_EDITABLE`).
`GET .../settings/retention/preview?section=&period=` counts the people the next nightly run would
empty under a period, for the dialog that confirms a shortening: one per account, or per email for
spells without one, however many spells they have.

**The clock** starts at the later of `employments.ended_at` and `end_recorded_at`, the moment the
ending was written, so a backdated ending never purges on the spot. Every end path stamps
`end_recorded_at`; migration 0045 backfilled older endings with `greatest(ended_at, updated_at)`,
which is never earlier than the real moment. Account deletion ends nothing, so it starts no clock.

**The purge** (`purgeRetention(now)` in `src/services/directory/retentionPurge.ts`, job
`runRetentionPurge` on the nightly tick) works out what is due from the clock start and the current
period. No due date is stored, so a change applies to Employments that already ended: a shorter
period removes what is past it at the next run, a longer one brings nothing back. It empties the
Section's fields and keeps the rows (Contact and Personal: the sealed column goes null, no key
needed), and for Photo deletes the Employment's photo folder, both sizes, before its rows, so a
store failure leaves the rows for the next night. Each emptied Section writes one Profile history
row. Every statement clears only rows that still hold data, so a second run, or a second instance,
finds nothing. It never asks the plan or the directory toggle, and notifies nobody. It never
touches the Employment row, its frozen name and email, its dates or its type.

**At end** Sections are emptied inside the transaction that ends the Employment:
`endLockedEmployment` (End and Erase) and the end branch of `syncEmployment`, which runs only while
the directory is off. That branch leaves the Profile photo, whose bytes can only go after a commit
it doesn't own, to the next nightly run, where "at end" counts as no time at all.

### Retention hold

`PUT|DELETE /api/directory/{organizationId}/people/{employmentId}/hold` sets and lifts a hold on
one ended Employment (422 `EMPLOYMENT_OPEN` on an open one), owner and org admins only (403
`HOLD_DENIED`), on every plan. The row in `directory_retention_holds` records who set it and when,
with no reason, and lifting deletes it. While it exists, `dueEmployments` skips the Employment, so
neither the nightly purge nor the shortening count touches it; the next run after lifting purges
what is due. Erase still works and takes the hold with the Employment.

### Removal dates

Nothing is stored: `readRetentionSchedules` (`retentionSchedule.ts`) works out, per Section of an
ended Employment, whether it holds data, when the current period runs out, and when a purge last
emptied it. A removal date is the day, in the nightly tick's zone, of the first run at or after the
period runs out, and never before the next run (`removalDay` in `retentionPeriods.ts`). The profile
of an ended record carries `retention`: the hold and, for each Section the viewer reads,
`REMOVES_ON` with a date, `REMOVED_ON` with the purge's day, `KEPT_UNTIL_ERASED`, or `ON_HOLD`.
Former list rows carry `nextRemoval` (the earliest `REMOVES_ON`, null under a hold) and `hold`.
