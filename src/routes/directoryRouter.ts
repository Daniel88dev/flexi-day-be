import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import {
  validateDirectoryEmailCheck,
  validatePatchDirectoryProfile,
  validatePatchPermissionCell,
  validatePostDirectoryInvite,
  validatePostDirectoryPerson,
  validatePutDirectoryGeneralSettings,
  validatePutRetentionPeriod,
  validatePutDirectoryRoles,
  validatePostProfilePhoto,
  validatePutWorkerType,
  validatePostCopyPreviousSpell,
} from "../services/directory/types.js";
import { handleGetDirectoryChecklist } from "../controllers/directory/handleGetDirectoryChecklist.js";
import { handlePostHideDirectoryChecklist } from "../controllers/directory/handlePostHideDirectoryChecklist.js";
import { handleGetPreviousSpell } from "../controllers/directory/handleGetPreviousSpell.js";
import { handlePostCopyPreviousSpell } from "../controllers/directory/handlePostCopyPreviousSpell.js";
import { handlePutWorkerType } from "../controllers/directory/handlePutWorkerType.js";
import { handleDeleteProfilePhoto } from "../controllers/directory/handleDeleteProfilePhoto.js";
import { handleGetProfilePhotoStatus } from "../controllers/directory/handleGetProfilePhotoStatus.js";
import { handlePostProfilePhoto } from "../controllers/directory/handlePostProfilePhoto.js";
import { handleGetDirectoryRoles } from "../controllers/directory/handleGetDirectoryRoles.js";
import { handleGetPermissionHistory } from "../controllers/directory/handleGetPermissionHistory.js";
import { handleGetPermissionTable } from "../controllers/directory/handleGetPermissionTable.js";
import { handlePatchPermissionCell } from "../controllers/directory/handlePatchPermissionCell.js";
import { handlePutDirectoryRoles } from "../controllers/directory/handlePutDirectoryRoles.js";
import { handleGetEndPreview } from "../controllers/directory/handleGetEndPreview.js";
import { handleGetProfileHistory } from "../controllers/directory/handleGetProfileHistory.js";
import { handlePostShowSection } from "../controllers/directory/handlePostShowSection.js";
import { handleGetReadLog } from "../controllers/directory/handleGetReadLog.js";
import { handleGetDirectoryGeneralSettings } from "../controllers/directory/handleGetDirectoryGeneralSettings.js";
import { handlePutDirectoryGeneralSettings } from "../controllers/directory/handlePutDirectoryGeneralSettings.js";
import { handleGetRetentionPreview } from "../controllers/directory/handleGetRetentionPreview.js";
import { handleGetRetentionSettings } from "../controllers/directory/handleGetRetentionSettings.js";
import { handlePutRetentionPeriod } from "../controllers/directory/handlePutRetentionPeriod.js";
import { handlePutRetentionHold } from "../controllers/directory/handlePutRetentionHold.js";
import { handleDeleteRetentionHold } from "../controllers/directory/handleDeleteRetentionHold.js";
import { handlePatchDirectoryProfile } from "../controllers/directory/handlePatchDirectoryProfile.js";
import { handlePostDirectoryEmailCheck } from "../controllers/directory/handlePostDirectoryEmailCheck.js";
import { handlePostDirectoryPerson } from "../controllers/directory/handlePostDirectoryPerson.js";
import { handlePostDirectoryInvite } from "../controllers/directory/handlePostDirectoryInvite.js";
import { handleGetDirectoryOrganizations } from "../controllers/directory/handleGetDirectoryOrganizations.js";
import { handleGetDirectoryPeople } from "../controllers/directory/handleGetDirectoryPeople.js";
import { handleGetDirectoryProfile } from "../controllers/directory/handleGetDirectoryProfile.js";
import { handleGetFormerDirectoryPeople } from "../controllers/directory/handleGetFormerDirectoryPeople.js";

export const directoryRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/directory/organizations:
   *   get:
   *     tags:
   *       - Directory
   *     summary: The organizations whose directory concerns the caller
   *     description: |
   *       Every organization the caller owns or administers, plus every one
   *       where they hold an open Employment, with whether its directory is
   *       on and whether its plan passes the directory gate. The web builds
   *       the People section from it: members see the Directory entry only
   *       where the directory is on; owners and org admins see it on every
   *       plan, with an Enterprise chip while the plan does not pass.
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: The caller's organizations
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 type: object
   *                 properties:
   *                   organizationId:
   *                     type: string
   *                   name:
   *                     type: string
   *                   role:
   *                     type: string
   *                     enum: [OWNER, ORGANIZATION_ADMIN, MEMBER]
   *                   enabled:
   *                     type: boolean
   *                   writable:
   *                     type: boolean
   *                   timezone:
   *                     type: string
   *                     description: |
   *                       The organization's IANA zone, UTC while attendance
   *                       was never set up. Employment start and end instants
   *                       name their day in it.
   *                   newAgreementVersionReady:
   *                     type: boolean
   *                     description: True only for the owner, while a newer agreement waits.
   *       '401':
   *         description: Not signed in
   */
  app.get("/organizations", tryCatch(handleGetDirectoryOrganizations));

  /**
   * @openapi
   * components:
   *   schemas:
   *     DirectoryMarker:
   *       type: string
   *       enum: [EXTERNAL_WORKER, NO_ACCOUNT, ACCOUNT_DELETED, REJOINED, INVITE_SENT]
   *       description: |
   *         Badges on a row. Everyone who reaches the record sees
   *         EXTERNAL_WORKER. NO_ACCOUNT, ACCOUNT_DELETED, REJOINED (an
   *         ended spell whose person started a later one) and INVITE_SENT (an
   *         open record without an account whose directory invite is still
   *         open) go to the owner, org admins and HR only.
   *     DirectoryPerson:
   *       type: object
   *       required: [employmentId, name, jobTitle, department, location, image, photoUrl, user, markers]
   *       properties:
   *         employmentId:
   *           type: string
   *         name:
   *           type: string
   *           description: |
   *             The account's name while it is bound, open and not deleted,
   *             otherwise the Employment's own copy.
   *         jobTitle:
   *           type: string
   *           nullable: true
   *           description: A Card field.
   *         department:
   *           nullable: true
   *           description: A Card field, the entry of the organization's Department list.
   *           allOf:
   *             - $ref: '#/components/schemas/DirectoryEntryRef'
   *         location:
   *           nullable: true
   *           description: A Card field, the entry of the organization's Location list.
   *           allOf:
   *             - $ref: '#/components/schemas/DirectoryEntryRef'
   *         image:
   *           type: string
   *           nullable: true
   *           description: The Account picture, the avatar when there is no Profile photo.
   *         photoUrl:
   *           type: string
   *           nullable: true
   *           description: |
   *             The small Profile photo, a signed link that stays the same for
   *             an hour. Null when there is none or the caller can't read the
   *             Photo Section; the avatar then falls back to `image`, then
   *             to initials.
   *         user:
   *           type: object
   *           description: |
   *             Initials and avatar colour, keyed on the user or, without an
   *             account, the Employment. `id` is null on a record without an
   *             account, for every caller.
   *           properties:
   *             id: { type: string, nullable: true }
   *             name: { type: string }
   *             initials: { type: string }
   *             avatarColor: { type: string }
   *         markers:
   *           type: array
   *           items:
   *             $ref: '#/components/schemas/DirectoryMarker'
   *         noGroup:
   *           type: boolean
   *           description: |
   *             In no group of the organization: no live membership and no
   *             managed group. People without an account always are. Sent on
   *             list rows to the owner and org admins only.
   *     DirectorySectionView:
   *       type: object
   *       required: [level]
   *       properties:
   *         level:
   *           type: string
   *           enum: [READ, WRITE]
   *     DirectoryPhotoView:
   *       allOf:
   *         - $ref: '#/components/schemas/DirectorySectionView'
   *         - type: object
   *           required: [photo]
   *           properties:
   *             photo:
   *               type: object
   *               nullable: true
   *               description: |
   *                 The Profile photo as two signed links, each the same for an
   *                 hour and valid for at least one more. Null when there is none.
   *               properties:
   *                 smallUrl:
   *                   type: string
   *                   description: For lists and cards.
   *                 fullUrl:
   *                   type: string
   *                   description: For the profile header.
   *     DirectoryCardView:
   *       allOf:
   *         - $ref: '#/components/schemas/DirectorySectionView'
   *         - type: object
   *           required: [jobTitle, reportsTo, nameFromAccount, department, location]
   *           properties:
   *             jobTitle:
   *               type: string
   *               nullable: true
   *             reportsTo:
   *               type: object
   *               nullable: true
   *               description: The Employment the person reports to. It grants no rights.
   *               properties:
   *                 employmentId:
   *                   type: string
   *                 name:
   *                   type: string
   *                   nullable: true
   *                   description: Null when the caller can't reach that person.
   *             nameFromAccount:
   *               type: boolean
   *               description: |
   *                 True while a bound, open account supplies the name, which
   *                 then can't be edited here.
   *             department:
   *               nullable: true
   *               allOf:
   *                 - $ref: '#/components/schemas/DirectoryEntryRef'
   *             location:
   *               nullable: true
   *               allOf:
   *                 - $ref: '#/components/schemas/DirectoryEntryRef'
   *                 - type: object
   *                   required: [country]
   *                   properties:
   *                     country:
   *                       nullable: true
   *                       allOf:
   *                         - $ref: '#/components/schemas/DirectoryCountry'
   *     DirectoryCountry:
   *       type: object
   *       required: [code, name]
   *       properties:
   *         code:
   *           type: string
   *           description: ISO 3166-1 alpha-2.
   *         name:
   *           type: string
   *           description: In the caller's language, for clients without `Intl.DisplayNames`.
   *     DirectoryPhone:
   *       type: object
   *       required: [e164, display, country]
   *       properties:
   *         e164:
   *           type: string
   *           description: The stored number, for `tel:` links.
   *         display:
   *           type: string
   *           description: The international format, for clients without a phone library.
   *         country:
   *           nullable: true
   *           allOf:
   *             - $ref: '#/components/schemas/DirectoryCountry'
   *     DirectoryWorkContactView:
   *       allOf:
   *         - $ref: '#/components/schemas/DirectorySectionView'
   *         - type: object
   *           required: [workEmail, workPhone]
   *           properties:
   *             workEmail:
   *               type: string
   *               nullable: true
   *               description: Lowercase. Separate from the sign-in email.
   *             workPhone:
   *               nullable: true
   *               allOf:
   *                 - $ref: '#/components/schemas/DirectoryPhone'
   *             phoneCountryDefault:
   *               nullable: true
   *               description: |
   *                 Present only for a caller who writes Work contact: the
   *                 country the edit form's phone picker starts on (the
   *                 Location's country, then the interface language, else null).
   *               allOf:
   *                 - $ref: '#/components/schemas/DirectoryCountry'
   *     DirectoryContactView:
   *       description: |
   *         The Contact Section on a profile, never with its values: only
   *         Show returns them. A caller who writes Contact also gets the
   *         Art. 14 notice, filled in for the organization in the caller's
   *         language, and the country the phone pickers start on.
   *       allOf:
   *         - $ref: '#/components/schemas/DirectorySectionView'
   *         - type: object
   *           properties:
   *             notice:
   *               type: string
   *             phoneCountryDefault:
   *               nullable: true
   *               allOf:
   *                 - $ref: '#/components/schemas/DirectoryCountry'
   *     DirectoryJobView:
   *       allOf:
   *         - $ref: '#/components/schemas/DirectorySectionView'
   *         - type: object
   *           required: [spell]
   *           properties:
   *             spell:
   *               type: object
   *               description: The Employment's own dates, the hint under Start date.
   *               properties:
   *                 startedAt:
   *                   type: string
   *                   format: date-time
   *                 endedAt:
   *                   type: string
   *                   format: date-time
   *                   nullable: true
   *             legalName:
   *               type: string
   *               nullable: true
   *             employeeNumber:
   *               type: string
   *               nullable: true
   *             startDate:
   *               type: string
   *               format: date
   *               nullable: true
   *               description: Never filled in from the spell start.
   *             leavingDate:
   *               type: string
   *               format: date
   *               nullable: true
   *             probationEndDate:
   *               type: string
   *               format: date
   *               nullable: true
   *             contractType:
   *               type: string
   *               nullable: true
   *               enum: [PERMANENT, FIXED_TERM, APPRENTICESHIP, INTERNSHIP, OTHER]
   *             workingTime:
   *               type: string
   *               nullable: true
   *               enum: [FULL_TIME, PART_TIME]
   *     DirectorySectionKey:
   *       type: string
   *       enum: [card, photo, workContact, job, contact, personal]
   *       description: A Section, named as the keys of a profile's `sections`.
   *     DirectorySectionRetention:
   *       type: object
   *       required: [status]
   *       description: |
   *         One Section's retention on an ended record. REMOVES_ON: the
   *         nightly run of `date` empties it (the day of the first run at or
   *         after its period runs out, in the nightly tick's zone, never
   *         before the next run). REMOVED_ON: a Retention purge emptied it on
   *         `date`. KEPT_UNTIL_ERASED: its period is until erased. ON_HOLD: it
   *         holds data that a Retention hold keeps.
   *       properties:
   *         status:
   *           type: string
   *           enum: [REMOVES_ON, REMOVED_ON, KEPT_UNTIL_ERASED, ON_HOLD]
   *         date:
   *           type: string
   *           format: date
   *           description: With REMOVES_ON and REMOVED_ON only.
   *     DirectoryProfileRetention:
   *       type: object
   *       description: |
   *         On an ended record only. Worked out from the clock and the
   *         organization's current Retention periods on every read.
   *       required: [hold, sections]
   *       properties:
   *         hold:
   *           nullable: true
   *           allOf:
   *             - $ref: '#/components/schemas/DirectoryRetentionHold'
   *         sections:
   *           type: object
   *           description: |
   *             Keyed like `sections`, only for Sections the caller reads. A
   *             Section that holds nothing, was never purged and has a finite
   *             period is absent.
   *           additionalProperties:
   *             $ref: '#/components/schemas/DirectorySectionRetention'
   *     DirectoryProfile:
   *       allOf:
   *         - $ref: '#/components/schemas/DirectoryPerson'
   *         - type: object
   *           required: [organizationId, self, ended, sections, canReadHistory, actions]
   *           properties:
   *             organizationId:
   *               type: string
   *             self:
   *               type: boolean
   *               description: The record is the caller's own.
   *             ended:
   *               type: boolean
   *             actions:
   *               type: object
   *               description: What the caller may do to this record from its profile.
   *               required: [end, export, erase, hold, invite, changeType, copyFromPreviousSpell]
   *               properties:
   *                 end:
   *                   type: boolean
   *                   description: |
   *                     End employment: the End act cell allows the caller,
   *                     the record is open and it isn't the owner's.
   *                 export:
   *                   type: boolean
   *                   description: The Person export. The owner and org admins, for any record.
   *                 erase:
   *                   type: boolean
   *                   description: Erase. The owner and org admins, for a Deleted account or a person without an account.
   *                 hold:
   *                   type: boolean
   *                   description: Set or lift the Retention hold. The owner and org admins, on an ended record.
   *                 invite:
   *                   type: boolean
   *                   description: |
   *                     Send directory invite: the act cell allows the caller
   *                     and the record is open and without an account. The
   *                     record may still lack the email it needs.
   *                 changeType:
   *                   type: boolean
   *                   description: Change worker type. The act cell allows the caller and the record is open.
   *                 copyFromPreviousSpell:
   *                   type: boolean
   *                   description: |
   *                     Copy from previous spell: the caller is the owner, an
   *                     org admin or HR, the record is open, and its previous
   *                     spell holds a Section the caller can copy. The web
   *                     shows its banner from this.
   *             canReadHistory:
   *               type: boolean
   *               description: The caller is the owner, an org admin or HR.
   *             retention:
   *               $ref: '#/components/schemas/DirectoryProfileRetention'
   *             sections:
   *               type: object
   *               properties:
   *                 card:
   *                   $ref: '#/components/schemas/DirectoryCardView'
   *                 photo:
   *                   $ref: '#/components/schemas/DirectoryPhotoView'
   *                 workContact:
   *                   $ref: '#/components/schemas/DirectoryWorkContactView'
   *                 job:
   *                   $ref: '#/components/schemas/DirectoryJobView'
   *                 contact:
   *                   $ref: '#/components/schemas/DirectoryContactView'
   *                 personal:
   *                   description: Absent on an External worker's record. Never carries values.
   *                   allOf:
   *                     - $ref: '#/components/schemas/DirectorySectionView'
   *             account:
   *               type: object
   *               properties:
   *                 status:
   *                   type: string
   *                   enum: [ACTIVE, NO_ACCOUNT, DELETED]
   *                 signInEmail:
   *                   type: string
   *                   nullable: true
   *                 directoryRoles:
   *                   type: array
   *                   items:
   *                     type: string
   *                     enum: [HR, LEADERSHIP]
   */

  /**
   * @openapi
   * /api/directory/{organizationId}/people:
   *   get:
   *     tags:
   *       - Directory
   *     summary: The directory list of an organization
   *     description: |
   *       The organization's open Employments whose Card the caller reads,
   *       through the organization's Permission table, sorted by name. People
   *       without an account and External workers are included. A lapsed plan
   *       keeps this readable. `formerList` says whether the caller may open
   *       the Former list (the owner, org admins and HR), `settings`
   *       whether they may open Directory settings (the same three), and
   *       `noGroupFilter` whether the rows carry `noGroup` (the owner and org
   *       admins), and `addPerson` whether the caller holds the Create
   *       account-less person act.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: The people the caller reaches
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [people, formerList, settings, noGroupFilter, addPerson]
   *               properties:
   *                 people:
   *                   type: array
   *                   items:
   *                     $ref: '#/components/schemas/DirectoryPerson'
   *                 formerList:
   *                   type: boolean
   *                 settings:
   *                   type: boolean
   *                 noGroupFilter:
   *                   type: boolean
   *                 addPerson:
   *                   type: boolean
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`: the caller is not the owner, an org admin or one of the organization's people"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF`: the directory is off in this organization"
   */
  app.get("/:organizationId/people", tryCatch(handleGetDirectoryPeople));

  /**
   * @openapi
   * /api/directory/{organizationId}/people:
   *   post:
   *     tags:
   *       - Directory
   *     summary: Add a person without an account
   *     description: |
   *       Opens an Employment with no account bound, holding the person's
   *       name, worker type and optional email, plus the Card fields given.
   *       Needs the Create account-less person act cell (Owner, HR and Org
   *       admin by default); the act covers the name and the Card fields
   *       without a Card write cell. Group admin never credits, because no
   *       group admin reaches a person without an account. One Card entry in
   *       the profile history records the name and the fields set.
   *
   *       The email is unique among the organization's open Employments,
   *       compared ignoring case. Such a person is in no group and gets no
   *       bookings, attendance, quotas or notifications. Needs the directory
   *       plan.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: language
   *         required: false
   *         description: The language of country names in the answer.
   *         schema:
   *           type: string
   *           enum: [en, cs]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             additionalProperties: false
   *             required: [name]
   *             properties:
   *               name:
   *                 type: string
   *                 minLength: 1
   *                 maxLength: 200
   *                 description: Trimmed.
   *               type:
   *                 type: string
   *                 enum: [employee, external]
   *                 default: employee
   *               email:
   *                 type: string
   *                 format: email
   *                 maxLength: 254
   *                 nullable: true
   *                 description: Stored lowercased.
   *               card:
   *                 type: object
   *                 additionalProperties: false
   *                 properties:
   *                   jobTitle:
   *                     type: string
   *                     minLength: 1
   *                     maxLength: 100
   *                     nullable: true
   *                   departmentId:
   *                     type: string
   *                     nullable: true
   *                   locationId:
   *                     type: string
   *                     nullable: true
   *                   reportsToEmploymentId:
   *                     type: string
   *                     nullable: true
   *                     description: Another open Employment of the organization.
   *     responses:
   *       '201':
   *         description: The new profile
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DirectoryProfile'
   *       '401':
   *         description: Not signed in
   *       '402':
   *         description: "`reason: PLAN_LIMIT`: the organization's plan doesn't include the directory"
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, or `CREATE_DENIED` without the Create account-less person act"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF`, or `EMPLOYMENT_EMAIL_TAKEN` when an open Employment holds the email"
   *       '422':
   *         description: "A malformed body, `ENTRY_NOT_FOUND`, `ENTRY_ARCHIVED`, `REPORTS_TO_NOT_FOUND` or `REPORTS_TO_SELF`"
   */
  app.post(
    "/:organizationId/people",
    bodyValidationMiddleware(validatePostDirectoryPerson),
    tryCatch(handlePostDirectoryPerson)
  );

  /**
   * @openapi
   * /api/directory/{organizationId}/people/email-check:
   *   post:
   *     tags:
   *       - Directory
   *     summary: Whether an email is free for Add person
   *     description: |
   *       Answers whether any open Employment of the organization, with or
   *       without an account, holds the email, ignoring case. The Add person
   *       dialog asks on blur. The email travels in the body, never the URL.
   *       Only for viewers holding the Create account-less person act cell.
   *       Writes nothing and is never plan-gated.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             additionalProperties: false
   *             required: [email]
   *             properties:
   *               email:
   *                 type: string
   *                 format: email
   *                 maxLength: 254
   *     responses:
   *       '200':
   *         description: The answer
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [available]
   *               properties:
   *                 available:
   *                   type: boolean
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY` or `CREATE_DENIED`"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF`"
   *       '422':
   *         description: A malformed body
   */
  app.post(
    "/:organizationId/people/email-check",
    bodyValidationMiddleware(validateDirectoryEmailCheck),
    tryCatch(handlePostDirectoryEmailCheck)
  );

  /**
   * @openapi
   * /api/directory/{organizationId}/people/{employmentId}/invite:
   *   post:
   *     tags:
   *       - Directory
   *     summary: Send a directory invite to a person without an account
   *     description: |
   *       Issues a single-use invite bound to the person's email and emails its
   *       link through the `directory-invite` template, which names the
   *       organization and never a group. Redeeming it (by link, by sign-up
   *       with invite or by code) binds the account to this Employment: the
   *       Claim. Naming a group is optional; the redeemer then also joins it,
   *       so the group must be a live group of the organization, writable and
   *       with a free seat. Sending again revokes the open invite first.
   *
   *       Needs the Send directory invite act cell (Owner, HR and Org admin by
   *       default). It resolves on the record, open and without an account,
   *       so Group admin never credits. Needs the directory plan. The code and
   *       the link secret never come back.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: employmentId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: false
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             additionalProperties: false
   *             properties:
   *               groupId:
   *                 type: string
   *                 format: uuid
   *                 nullable: true
   *                 description: A group the person joins on redeeming. Omit for none.
   *     responses:
   *       '201':
   *         description: The invite. `emailDelivered` is false when the email failed; send again.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [invite, emailDelivered]
   *               properties:
   *                 emailDelivered:
   *                   type: boolean
   *                 invite:
   *                   type: object
   *                   required: [id, employmentId, groupId, email, status, expiresAt, createdAt]
   *                   properties:
   *                     id:
   *                       type: string
   *                     employmentId:
   *                       type: string
   *                     groupId:
   *                       type: string
   *                       nullable: true
   *                     email:
   *                       type: string
   *                       format: email
   *                     status:
   *                       type: string
   *                       enum: [open]
   *                     expiresAt:
   *                       type: string
   *                       format: date-time
   *                     createdAt:
   *                       type: string
   *                       format: date-time
   *       '401':
   *         description: Not signed in
   *       '402':
   *         description: "`reason: PLAN_LIMIT`: the plan doesn't include the directory, the group is read-only or full"
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, or `INVITE_DENIED` without the Send directory invite act"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`, or `PERSON_NOT_FOUND` when the record is elsewhere or out of reach"
   *       '409':
   *         description: "`DIRECTORY_OFF`, or `EMPLOYMENT_ENDED`"
   *       '422':
   *         description: "A malformed body, `HAS_ACCOUNT`, `NO_EMAIL` or `GROUP_NOT_FOUND`"
   */
  app.post(
    "/:organizationId/people/:employmentId/invite",
    bodyValidationMiddleware(validatePostDirectoryInvite),
    tryCatch(handlePostDirectoryInvite)
  );

  /**
   * @openapi
   * /api/directory/{organizationId}/people/{employmentId}/worker-type:
   *   put:
   *     tags:
   *       - Directory
   *     summary: Change worker type between employee and External worker
   *     description: |
   *       Sets the Employment's type. Changing to `external` clears Contract
   *       type, Working time, Probation end date and the whole Personal
   *       section, drops the required-time override, and sets the person's
   *       allowances in the organization's groups to zero from the current
   *       year on, all in one transaction. Profile history gets a JOB row and
   *       a PERSONAL row for what was cleared, and a `CHANGE_WORKER_TYPE` row
   *       with the field `type`, never values. Changing back to `employee`
   *       restores nothing: the cleared fields start empty.
   *
   *       An External worker can't clock in, owes no required time, is left
   *       out of Team attendance, and books only record types that draw on no
   *       allowance.
   *
   *       Needs the Change worker type act cell (Owner, HR and Org admin by
   *       default), resolved on the record. Works on a lapsed plan. Setting the
   *       type the record already has changes nothing and answers 200.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: employmentId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             additionalProperties: false
   *             required: [type]
   *             properties:
   *               type:
   *                 type: string
   *                 enum: [employee, external]
   *     responses:
   *       '200':
   *         description: The profile after the change
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DirectoryProfile'
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, or `WORKER_TYPE_DENIED` without the Change worker type act"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`, or `PERSON_NOT_FOUND` when the record is elsewhere or out of reach"
   *       '409':
   *         description: "`DIRECTORY_OFF`, or `EMPLOYMENT_ENDED`"
   *       '422':
   *         description: A malformed body
   */
  app.put(
    "/:organizationId/people/:employmentId/worker-type",
    bodyValidationMiddleware(validatePutWorkerType),
    tryCatch(handlePutWorkerType)
  );

  /**
   * @openapi
   * components:
   *   schemas:
   *     DirectoryCopyableSection:
   *       type: object
   *       required: [status]
   *       description: |
   *         What one Section of the previous spell offers this spell.
   *         COPYABLE: the previous spell holds it and the caller may write it
   *         here. REMOVED_ON: a Retention purge emptied it on the previous
   *         spell, on `date`. EMPTY: the previous spell holds nothing else.
   *         FILLED: this spell already holds it, and a copy never overwrites.
   *         NOT_WRITABLE: the caller's cells don't allow writing it here.
   *       properties:
   *         status:
   *           type: string
   *           enum: [COPYABLE, REMOVED_ON, EMPTY, FILLED, NOT_WRITABLE]
   *         date:
   *           type: string
   *           format: date
   *           description: Only with REMOVED_ON, the day of the purge in the nightly run's zone.
   * /api/directory/{organizationId}/people/{employmentId}/previous-spell:
   *   get:
   *     tags:
   *       - Directory
   *     summary: What Copy from previous spell can bring over to this spell
   *     description: |
   *       The person's previous spell in the organization, and for each of
   *       Contact, Personal and Photo whether it can be copied onto this open
   *       spell. The previous spell is the latest ended Employment begun
   *       before this one with the same user, or with the same email when
   *       either spell has no account. Card, Work contact and Job never carry
   *       over, and Personal is absent when this spell is an External
   *       worker's. Never carries values. For the owner, org admins and HR;
   *       readable on a lapsed plan.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: employmentId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: The previous spell and its Sections
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [previous, sections]
   *               properties:
   *                 previous:
   *                   type: object
   *                   required: [employmentId, startedAt, endedAt]
   *                   properties:
   *                     employmentId:
   *                       type: string
   *                     startedAt:
   *                       type: string
   *                       format: date-time
   *                     endedAt:
   *                       type: string
   *                       format: date-time
   *                 sections:
   *                   type: object
   *                   properties:
   *                     contact:
   *                       $ref: '#/components/schemas/DirectoryCopyableSection'
   *                     personal:
   *                       $ref: '#/components/schemas/DirectoryCopyableSection'
   *                     photo:
   *                       $ref: '#/components/schemas/DirectoryCopyableSection'
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, or `COPY_DENIED` for anyone but the owner, org admins and HR"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`, `PERSON_NOT_FOUND` when the record is elsewhere or out of reach, or `NO_PREVIOUS_SPELL`"
   *       '409':
   *         description: "`DIRECTORY_OFF`, or `EMPLOYMENT_ENDED` when this spell has ended"
   */
  app.get("/:organizationId/people/:employmentId/previous-spell", tryCatch(handleGetPreviousSpell));

  /**
   * @openapi
   * /api/directory/{organizationId}/people/{employmentId}/previous-spell/copy:
   *   post:
   *     tags:
   *       - Directory
   *     summary: Copy from previous spell
   *     description: |
   *       Copies whole Sections, among Contact, Personal and Photo, from the
   *       person's previous spell onto this open spell, as far as retention
   *       left them. Contact and Personal are opened and sealed again for the
   *       new record; the Profile photo's two sizes are stored again under the
   *       new spell. A Section this spell already holds is never overwritten.
   *       Each copied Section writes a profile history row naming its fields,
   *       never values, with the caller and the Audience that grants them
   *       Write on it. The values never reach the caller, so no read-log row
   *       is written. For the owner, org admins and HR, with Write on each
   *       chosen Section; needs the directory plan.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: employmentId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             additionalProperties: false
   *             required: [sections]
   *             properties:
   *               sections:
   *                 type: array
   *                 minItems: 1
   *                 maxItems: 3
   *                 items:
   *                   type: string
   *                   enum: [contact, personal, photo]
   *     responses:
   *       '200':
   *         description: The profile after the copy
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DirectoryProfile'
   *       '401':
   *         description: Not signed in
   *       '402':
   *         description: "`DIRECTORY_PLAN_REQUIRED`: the organization's plan has lapsed"
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, `COPY_DENIED`, or `SECTION_NOT_WRITABLE` for a chosen Section the caller can't write"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`, `PERSON_NOT_FOUND`, or `NO_PREVIOUS_SPELL`"
   *       '409':
   *         description: "`DIRECTORY_OFF`, `EMPLOYMENT_ENDED`, `SECTION_ALREADY_FILLED` when this spell holds a chosen Section, or `SECTION_NOT_HELD` when the previous spell no longer does"
   *       '422':
   *         description: "A malformed body, or `EMPLOYEES_ONLY` for Personal on an External worker's spell"
   *       '503':
   *         description: The organization-data store is not configured
   */
  app.post(
    "/:organizationId/people/:employmentId/previous-spell/copy",
    bodyValidationMiddleware(validatePostCopyPreviousSpell),
    tryCatch(handlePostCopyPreviousSpell)
  );

  /**
   * @openapi
   * /api/directory/{organizationId}/former:
   *   get:
   *     tags:
   *       - Directory
   *     summary: The Former list of an organization
   *     description: |
   *       One row per ended Employment spell whose Card the caller reads,
   *       latest end first. Only the owner, org admins and HR see it. A lapsed
   *       plan keeps this readable. Each row carries the next Retention purge
   *       and whether a Retention hold is on; ACCOUNT_DELETED and REJOINED
   *       come in `markers`.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: The ended spells
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 allOf:
   *                   - $ref: '#/components/schemas/DirectoryPerson'
   *                   - type: object
   *                     required: [startedAt, endedAt, nextRemoval, hold]
   *                     properties:
   *                       startedAt:
   *                         type: string
   *                         format: date-time
   *                         nullable: true
   *                         description: Null when the caller doesn't read Job.
   *                       endedAt:
   *                         type: string
   *                         format: date-time
   *                         nullable: true
   *                         description: |
   *                           Null when the caller doesn't read Job. The list
   *                           is sorted by it either way, latest first.
   *                       nextRemoval:
   *                         type: object
   *                         nullable: true
   *                         description: |
   *                           The earliest coming Retention purge among the
   *                           Sections the caller reads, ties in Section order.
   *                           Null when nothing is due to go or a hold is on.
   *                         required: [section, date]
   *                         properties:
   *                           section:
   *                             $ref: '#/components/schemas/DirectorySectionKey'
   *                           date:
   *                             type: string
   *                             format: date
   *                       hold:
   *                         type: boolean
   *                         description: A Retention hold is on.
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, or `FORMER_LIST_DENIED` for anyone but the owner, org admins and HR"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF`"
   */
  app.get("/:organizationId/former", tryCatch(handleGetFormerDirectoryPeople));

  /**
   * @openapi
   * /api/directory/{organizationId}/people/{employmentId}:
   *   get:
   *     tags:
   *       - Directory
   *     summary: One profile, with only the Sections the caller reads
   *     description: |
   *       The profile of one Employment, open or ended. `sections` holds a key
   *       only for each Section the caller reads, at their level: a Section
   *       they can't read is absent. Contact and Personal carry no values here,
   *       for anyone, the person included: `POST .../show/{section}` returns
   *       them. Opening a profile writes no read-log row. Personal is absent
   *       on an External worker's record.
   *       The spell dates sit in `job`, so only Job readers get them.
   *       `account` (status, sign-in email, directory roles) is present for
   *       the owner, org admins, HR and the person. An ended record is reached
   *       only by the owner, org admins and HR. A lapsed plan keeps this
   *       readable. An ended record also carries `retention`: its Retention
   *       hold and when each Section goes or went.
   *
   *       Every phone carries its display form and every country its name in
   *       the caller's language, because the iPhone app formats neither.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: employmentId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: language
   *         required: false
   *         description: The language of country names. Defaults to the caller's stored language, then English.
   *         schema:
   *           type: string
   *           enum: [en, cs]
   *     responses:
   *       '200':
   *         description: The profile
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DirectoryProfile'
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`, or `PERSON_NOT_FOUND` when the record is elsewhere or out of the caller's reach"
   *       '409':
   *         description: "`DIRECTORY_OFF`"
   */
  app.get("/:organizationId/people/:employmentId", tryCatch(handleGetDirectoryProfile));

  /**
   * @openapi
   * /api/directory/{organizationId}/people/{employmentId}:
   *   patch:
   *     tags:
   *       - Directory
   *     summary: Edit the Sections of a profile
   *     description: |
   *       Sets or clears Card, Work contact, Job, Contact and Personal fields
   *       of one Employment, open or ended.
   *       In each field a value sets it, `null` clears it and a missing key
   *       leaves it as it is. Each Section in the body needs a write cell for
   *       the caller in the organization's Permission table. The profile row
   *       is created on the first write.
   *
   *       `card.name` edits the Employment's own copy of the name, and only
   *       when no account is bound, the spell has ended or the account was
   *       deleted. A bound, open account's name and sign-in email follow the
   *       account. The name is never cleared.
   *
   *       `card.email` sets, changes or clears the address of an open record
   *       without an account, the one a directory invite goes to. It is
   *       unique, ignoring case, among the organization's open Employments,
   *       and a change revokes the record's open directory invite.
   *
   *       Setting any value needs the directory plan (Enterprise or Custom).
   *       A body that only clears works on every plan. Contract type, working
   *       time and probation end date apply to employees only. The employee
   *       number is unique, ignoring case, among the organization's open
   *       Employments. A work phone is one number in international form with
   *       no extension, stored in E.164; a work email is stored lowercase.
   *
   *       Contact and Personal are Sensitive sections, stored encrypted under
   *       the organization's data key. The answer never carries their values,
   *       so a write writes no read-log row. A filled emergency contact needs a
   *       name and a phone; a filled home address needs line 1, city and an
   *       ISO 3166-1 alpha-2 country; a date of birth lies between 1900-01-01
   *       and today. Personal applies to employees only.
   *
   *       Each Section the write changed adds one profile history entry: who,
   *       when, which fields and through which Audience, never the values.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: employmentId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: language
   *         required: false
   *         description: The language of country names. Defaults to the caller's stored language, then English.
   *         schema:
   *           type: string
   *           enum: [en, cs]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             additionalProperties: false
   *             properties:
   *               card:
   *                 type: object
   *                 additionalProperties: false
   *                 properties:
   *                   name:
   *                     type: string
   *                     minLength: 1
   *                     maxLength: 200
   *                     description: Trimmed. Refused for a bound, open account.
   *                   email:
   *                     type: string
   *                     format: email
   *                     maxLength: 254
   *                     nullable: true
   *                     description: Stored lowercase. Only on an open record without an account.
   *                   jobTitle:
   *                     type: string
   *                     nullable: true
   *                     minLength: 1
   *                     maxLength: 100
   *                     description: Trimmed.
   *                   reportsToEmploymentId:
   *                     type: string
   *                     nullable: true
   *                     description: Another open Employment of the same organization, never the person's own.
   *                   departmentId:
   *                     type: string
   *                     nullable: true
   *                     description: An entry of the organization's Department list. An archived one only if the record already holds it.
   *                   locationId:
   *                     type: string
   *                     nullable: true
   *                     description: An entry of the organization's Location list. An archived one only if the record already holds it.
   *               workContact:
   *                 type: object
   *                 additionalProperties: false
   *                 properties:
   *                   workEmail:
   *                     type: string
   *                     format: email
   *                     nullable: true
   *                     maxLength: 254
   *                     description: Stored lowercase. Never synced with the sign-in email.
   *                   workPhone:
   *                     type: string
   *                     nullable: true
   *                     maxLength: 40
   *                     description: International form, such as `+420 601 123 456`. Stored in E.164.
   *               job:
   *                 type: object
   *                 additionalProperties: false
   *                 properties:
   *                   legalName:
   *                     type: string
   *                     nullable: true
   *                     minLength: 1
   *                     maxLength: 200
   *                   employeeNumber:
   *                     type: string
   *                     nullable: true
   *                     minLength: 1
   *                     maxLength: 50
   *                   startDate:
   *                     type: string
   *                     format: date
   *                     nullable: true
   *                   leavingDate:
   *                     type: string
   *                     format: date
   *                     nullable: true
   *                     description: Informational. It ends nothing.
   *                   probationEndDate:
   *                     type: string
   *                     format: date
   *                     nullable: true
   *                     description: Not before the start date. Employees only.
   *                   contractType:
   *                     type: string
   *                     nullable: true
   *                     enum: [PERMANENT, FIXED_TERM, APPRENTICESHIP, INTERNSHIP, OTHER]
   *                     description: Employees only.
   *                   workingTime:
   *                     type: string
   *                     nullable: true
   *                     enum: [FULL_TIME, PART_TIME]
   *                     description: Employees only.
   *               contact:
   *                 type: object
   *                 additionalProperties: false
   *                 properties:
   *                   privatePhone:
   *                     type: string
   *                     nullable: true
   *                     maxLength: 40
   *                     description: International form. Stored in E.164.
   *                   privateEmail:
   *                     type: string
   *                     format: email
   *                     nullable: true
   *                     maxLength: 254
   *                     description: Stored lowercase.
   *                   emergencyContact1:
   *                     $ref: '#/components/schemas/DirectoryEmergencyContactInput'
   *                   emergencyContact2:
   *                     $ref: '#/components/schemas/DirectoryEmergencyContactInput'
   *               personal:
   *                 type: object
   *                 additionalProperties: false
   *                 description: Employees only.
   *                 properties:
   *                   homeAddress:
   *                     type: object
   *                     nullable: true
   *                     additionalProperties: false
   *                     required: [line1, city, country]
   *                     properties:
   *                       line1: { type: string, minLength: 1, maxLength: 200 }
   *                       line2: { type: string, nullable: true, maxLength: 200 }
   *                       postalCode: { type: string, nullable: true, maxLength: 16 }
   *                       city: { type: string, minLength: 1, maxLength: 100 }
   *                       region: { type: string, nullable: true, maxLength: 100 }
   *                       country:
   *                         type: string
   *                         minLength: 2
   *                         maxLength: 2
   *                         description: ISO 3166-1 alpha-2.
   *                   dateOfBirth:
   *                     type: string
   *                     format: date
   *                     nullable: true
   *                     description: From 1900-01-01 to today.
   *     responses:
   *       '200':
   *         description: The profile as the caller now reads it
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DirectoryProfile'
   *       '401':
   *         description: Not signed in
   *       '402':
   *         description: "`reason: PLAN_LIMIT`, `code: DIRECTORY_PLAN_REQUIRED`: the body sets a value and the plan is not Enterprise or Custom"
   *       '403':
   *         description: |
   *           `NOT_IN_DIRECTORY`, `SECTION_NOT_WRITABLE` when the caller has no
   *           write cell for a Section in the body, or `NAME_FROM_ACCOUNT` for
   *           the name of a bound, open account.
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`, or `PERSON_NOT_FOUND` when the record is elsewhere or out of the caller's reach"
   *       '409':
   *         description: "`DIRECTORY_OFF`, `EMPLOYEE_NUMBER_TAKEN` when another open Employment holds the number, or `EMPLOYMENT_EMAIL_TAKEN` when one holds the email"
   *       '422':
   *         description: |
   *           A malformed body, `EMAIL_FROM_ACCOUNT` (an email for a record
   *           with an account or one that ended), or `EMPLOYEES_ONLY` (an employee-only field set
   *           on an External worker), `PROBATION_BEFORE_START`,
   *           `REPORTS_TO_NOT_FOUND` (not an open Employment of the
   *           organization), `REPORTS_TO_SELF`, `INVALID_PHONE`,
   *           `INVALID_COUNTRY`, `DATE_OF_BIRTH_OUT_OF_RANGE`, `ENTRY_NOT_FOUND`
   *           (no such Department or Location in the organization) or
   *           `ENTRY_ARCHIVED` (an archived entry given to a record that
   *           doesn't hold it). `EMPLOYEES_ONLY` also answers Personal on an
   *           External worker's record.
   */
  app.patch(
    "/:organizationId/people/:employmentId",
    bodyValidationMiddleware(validatePatchDirectoryProfile),
    tryCatch(handlePatchDirectoryProfile)
  );

  /**
   * @openapi
   * /api/directory/{organizationId}/people/{employmentId}/history:
   *   get:
   *     tags:
   *       - Directory
   *     summary: A profile's history
   *     description: |
   *       Every write to the profile, newest first: who made it, when, the
   *       Section, the fields it changed and the Audience that granted it.
   *       A Retention purge reads `actor` RETENTION, with no actor name and no
   *       Audience. Never the values. The owner, org admins and HR only. A
   *       lapsed plan keeps this readable.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: employmentId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: The history entries
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 type: object
   *                 required: [id, at, actorName, section, fields, actor, audience]
   *                 properties:
   *                   id:
   *                     type: string
   *                   at:
   *                     type: string
   *                     format: date-time
   *                   actorName:
   *                     type: string
   *                     nullable: true
   *                   section:
   *                     type: string
   *                     enum: [CARD, PHOTO, WORK_CONTACT, JOB, CONTACT, PERSONAL]
   *                   fields:
   *                     type: array
   *                     items:
   *                       type: string
   *                   actor:
   *                     type: string
   *                     enum: [PERSON, RETENTION]
   *                     description: RETENTION for a Retention purge, PERSON for everything else.
   *                   audience:
   *                     type: string
   *                     nullable: true
   *                     description: Null on a Retention purge.
   *                     enum: [OWNER, SELF, COLLEAGUE, EXTERNAL_WORKER, GROUP_ADMIN, HR, LEADERSHIP, ORGANIZATION_ADMIN]
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, or `HISTORY_DENIED` for anyone but the owner, org admins and HR"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`, or `PERSON_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF`"
   */
  app.get("/:organizationId/people/:employmentId/history", tryCatch(handleGetProfileHistory));

  /**
   * @openapi
   * /api/directory/{organizationId}/people/{employmentId}/end-preview:
   *   get:
   *     tags:
   *       - Directory
   *     summary: What End employment would do to this record
   *     description: |
   *       For the End dialog: the dates End accepts and the one to suggest,
   *       the open records whose Reports to it clears, the groups the person
   *       leaves, the groups they manage (End is refused while any is
   *       listed), how many booked days it cancels, whether it drops a
   *       delegated org-admin row, and the Directory roles it ends. People
   *       without an account have no groups, bookings or admin row. Only for
   *       a caller whose End act cell allows it; never plan-gated. End itself
   *       is `POST /api/employment/{employmentId}/end`.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: employmentId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: The effects of ending today or earlier
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [employmentId, today, startedOn, suggestedEndedOn, reportees, groups, managedGroups, cancelledBookings, organizationAdmin, directoryRoles, atEndSections]
   *               properties:
   *                 employmentId:
   *                   type: string
   *                 today:
   *                   type: string
   *                   format: date
   *                   description: Today in the organization's time zone, the latest date End accepts.
   *                 startedOn:
   *                   type: string
   *                   format: date
   *                   description: The spell's first day, the earliest date End accepts.
   *                 suggestedEndedOn:
   *                   type: string
   *                   format: date
   *                   description: The Leaving date when it is today or earlier, otherwise today.
   *                 reportees:
   *                   type: array
   *                   description: Open records whose Reports to names this person, by name.
   *                   items:
   *                     type: object
   *                     required: [employmentId, name]
   *                     properties:
   *                       employmentId: { type: string }
   *                       name: { type: string }
   *                 groups:
   *                   type: array
   *                   items:
   *                     type: object
   *                     required: [id, name]
   *                     properties:
   *                       id: { type: string }
   *                       name: { type: string }
   *                 managedGroups:
   *                   type: array
   *                   items:
   *                     type: object
   *                     required: [id, name]
   *                     properties:
   *                       id: { type: string }
   *                       name: { type: string }
   *                 cancelledBookings:
   *                   type: integer
   *                   minimum: 0
   *                   description: Pending requests and approved days after today.
   *                 organizationAdmin:
   *                   type: boolean
   *                   description: The person holds a delegated org-admin row End drops.
   *                 directoryRoles:
   *                   type: array
   *                   items:
   *                     type: string
   *                     enum: [HR, LEADERSHIP]
   *                 atEndSections:
   *                   type: array
   *                   description: Sections whose Retention period is "at end" and that hold something; End empties them in its transaction.
   *                   items:
   *                     type: string
   *                     enum: [CARD, PHOTO, WORK_CONTACT, JOB, CONTACT, PERSONAL]
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, or `END_DENIED` when the End act cell doesn't allow the caller, or the record is the owner's"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`, or `PERSON_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF`, or `EMPLOYMENT_ENDED`"
   */
  app.get("/:organizationId/people/:employmentId/end-preview", tryCatch(handleGetEndPreview));

  /**
   * @openapi
   * components:
   *   schemas:
   *     DirectoryRetentionHold:
   *       type: object
   *       required: [setAt, setBy]
   *       properties:
   *         setAt:
   *           type: string
   *           format: date-time
   *         setBy:
   *           type: object
   *           nullable: true
   *           description: Null once the setter's account is gone.
   *           required: [userId, name]
   *           properties:
   *             userId: { type: string }
   *             name: { type: string, nullable: true }
   * /api/directory/{organizationId}/people/{employmentId}/hold:
   *   put:
   *     tags:
   *       - Directory
   *     summary: Put a Retention hold on an ended Employment
   *     description: |
   *       While the hold is on, every Retention purge skips the Employment:
   *       the nightly step empties none of its Sections, and the shortening
   *       count leaves it out. Erase still works. The hold records who set it
   *       and when, and has no reason. Setting it again keeps the first
   *       setter and time. The owner and org admins only, on every plan, with
   *       the directory on or off.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: employmentId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: The hold
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [hold]
   *               properties:
   *                 hold:
   *                   $ref: '#/components/schemas/DirectoryRetentionHold'
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, or `HOLD_DENIED` for anyone but the owner and org admins"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`, or `PERSON_NOT_FOUND` when the Employment is elsewhere"
   *       '409':
   *         description: "`DIRECTORY_OFF` for a caller other than the owner or an org admin: they reach this while the directory is off too"
   *       '422':
   *         description: "`EMPLOYMENT_OPEN`: a hold applies to an ended Employment"
   *   delete:
   *     tags:
   *       - Directory
   *     summary: Lift the Retention hold
   *     description: |
   *       The next nightly run purges whatever is past its Retention period.
   *       Lifting a hold that isn't there succeeds. The owner and org admins
   *       only, on every plan.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: employmentId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: The hold is off
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [hold]
   *               properties:
   *                 hold:
   *                   type: object
   *                   nullable: true
   *                   description: Always null.
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, or `HOLD_DENIED`"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`, or `PERSON_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF` for a caller other than the owner or an org admin: they reach this while the directory is off too"
   *       '422':
   *         description: "`EMPLOYMENT_OPEN`"
   */
  app.put("/:organizationId/people/:employmentId/hold", tryCatch(handlePutRetentionHold));
  app.delete("/:organizationId/people/:employmentId/hold", tryCatch(handleDeleteRetentionHold));

  /**
   * @openapi
   * components:
   *   schemas:
   *     DirectoryEmergencyContact:
   *       type: object
   *       required: [name, phone]
   *       properties:
   *         name:
   *           type: string
   *         phone:
   *           $ref: '#/components/schemas/DirectoryPhone'
   *     DirectoryEmergencyContactInput:
   *       type: object
   *       nullable: true
   *       additionalProperties: false
   *       required: [name, phone]
   *       description: A filled slot needs both. `null` clears it.
   *       properties:
   *         name:
   *           type: string
   *           minLength: 1
   *           maxLength: 100
   *         phone:
   *           type: string
   *           maxLength: 40
   *           description: International form. Stored in E.164.
   *     DirectoryShownContact:
   *       type: object
   *       required: [section, level, recorded, privatePhone, privateEmail, emergencyContact1, emergencyContact2]
   *       properties:
   *         section:
   *           type: string
   *           enum: [CONTACT]
   *         level:
   *           type: string
   *           enum: [READ, WRITE]
   *         recorded:
   *           type: boolean
   *           description: A read-log row was written. False for the person's own record.
   *         privatePhone:
   *           nullable: true
   *           allOf:
   *             - $ref: '#/components/schemas/DirectoryPhone'
   *         privateEmail:
   *           type: string
   *           nullable: true
   *         emergencyContact1:
   *           nullable: true
   *           allOf:
   *             - $ref: '#/components/schemas/DirectoryEmergencyContact'
   *         emergencyContact2:
   *           nullable: true
   *           allOf:
   *             - $ref: '#/components/schemas/DirectoryEmergencyContact'
   *     DirectoryShownPersonal:
   *       type: object
   *       required: [section, level, recorded, homeAddress, dateOfBirth]
   *       properties:
   *         section:
   *           type: string
   *           enum: [PERSONAL]
   *         level:
   *           type: string
   *           enum: [READ, WRITE]
   *         recorded:
   *           type: boolean
   *           description: A read-log row was written. False for the person's own record.
   *         homeAddress:
   *           type: object
   *           nullable: true
   *           required: [line1, line2, postalCode, city, region, country]
   *           properties:
   *             line1: { type: string }
   *             line2: { type: string, nullable: true }
   *             postalCode: { type: string, nullable: true }
   *             city: { type: string }
   *             region: { type: string, nullable: true }
   *             country:
   *               $ref: '#/components/schemas/DirectoryCountry'
   *         dateOfBirth:
   *           type: string
   *           format: date
   *           nullable: true
   */

  /**
   * @openapi
   * /api/directory/{organizationId}/people/{employmentId}/show/{section}:
   *   post:
   *     tags:
   *       - Directory
   *     summary: Show one Sensitive section of a profile
   *     description: |
   *       Returns the values of Contact or Personal, the only route that
   *       carries them. The caller needs a read cell for the Section in the
   *       organization's Permission table. For anyone but the person, each
   *       call writes one read-log row: reader, Employment, Section, the
   *       Audience that granted the read and the time, never the values. The
   *       person's own record writes none. Personal applies to employees
   *       only. A lapsed plan keeps this readable. The answer is never cached.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: employmentId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: section
   *         required: true
   *         schema:
   *           type: string
   *           enum: [contact, personal]
   *       - in: query
   *         name: language
   *         required: false
   *         description: The language of country names. Defaults to the caller's stored language, then English.
   *         schema:
   *           type: string
   *           enum: [en, cs]
   *     responses:
   *       '200':
   *         description: The Section's values
   *         content:
   *           application/json:
   *             schema:
   *               oneOf:
   *                 - $ref: '#/components/schemas/DirectoryShownContact'
   *                 - $ref: '#/components/schemas/DirectoryShownPersonal'
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, or `SECTION_NOT_READABLE` when the caller has no read cell for the Section"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`, `PERSON_NOT_FOUND`, or `SECTION_NOT_FOUND` for a Section other than contact and personal"
   *       '409':
   *         description: "`DIRECTORY_OFF`"
   *       '422':
   *         description: "`EMPLOYEES_ONLY`: Personal on an External worker's record"
   */
  app.post("/:organizationId/people/:employmentId/show/:section", tryCatch(handlePostShowSection));

  /**
   * @openapi
   * /api/directory/{organizationId}/read-log:
   *   get:
   *     tags:
   *       - Directory
   *     summary: The organization's Read log
   *     description: |
   *       Who read a Sensitive section of someone else's profile, when, which
   *       Sections and through which Audience, plus every Person and
   *       Organization export (kind `export`), newest first. Readers' names are
   *       included; values never are, because the rows hold none. The owner and
   *       org admins only; HR reads it only by also being an org admin. Rows are
   *       kept 12 months. `people` and `readers` list everyone the log holds,
   *       for the filters. A lapsed plan keeps this readable, and the owner and
   *       org admins read it while the directory is off too.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: employmentId
   *         required: false
   *         description: |
   *           Only rows about this person: this Employment and every other
   *           spell of the same account, or of the same email without one.
   *         schema:
   *           type: string
   *       - in: query
   *         name: readerUserId
   *         required: false
   *         description: Only rows by this reader.
   *         schema:
   *           type: string
   *       - in: query
   *         name: before
   *         required: false
   *         description: The `nextBefore` of the previous page.
   *         schema:
   *           type: string
   *       - in: query
   *         name: limit
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 200
   *           default: 50
   *     responses:
   *       '200':
   *         description: One page of the log
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [entries, nextBefore, people, readers]
   *               properties:
   *                 entries:
   *                   type: array
   *                   items:
   *                     type: object
   *                     required: [id, kind, at, reader, person, sections, audience]
   *                     properties:
   *                       id:
   *                         type: string
   *                       kind:
   *                         type: string
   *                         enum: [read, export]
   *                       at:
   *                         type: string
   *                         format: date-time
   *                       reader:
   *                         type: object
   *                         properties:
   *                           userId: { type: string }
   *                           name: { type: string, nullable: true }
   *                       person:
   *                         type: object
   *                         properties:
   *                           employmentId: { type: string, nullable: true }
   *                           name:
   *                             type: string
   *                             nullable: true
   *                             description: Null once the person was erased.
   *                       sections:
   *                         type: array
   *                         nullable: true
   *                         description: The Sections a read opened; null on an export.
   *                         items:
   *                           type: string
   *                           enum: [CONTACT, PERSONAL]
   *                       audience:
   *                         type: string
   *                         enum: [OWNER, ORGANIZATION_ADMIN, SELF, HR, LEADERSHIP, GROUP_ADMIN, COLLEAGUE, EXTERNAL_WORKER]
   *                 nextBefore:
   *                   type: string
   *                   nullable: true
   *                 people:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       employmentId: { type: string }
   *                       name: { type: string }
   *                 readers:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       userId: { type: string }
   *                       name: { type: string, nullable: true }
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, or `READ_LOG_DENIED` for anyone but the owner and org admins"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF` for a caller other than the owner or an org admin: they reach this while the directory is off too"
   *       '422':
   *         description: A malformed query
   */
  app.get("/:organizationId/read-log", tryCatch(handleGetReadLog));

  /**
   * @openapi
   * components:
   *   schemas:
   *     DirectoryGeneralSettings:
   *       type: object
   *       required: [editable, emergencyContactNotice, defaults, period]
   *       properties:
   *         editable:
   *           type: boolean
   *           description: The caller is the owner or an org admin, who change these. HR reads them.
   *         emergencyContactNotice:
   *           type: object
   *           description: The organization's own Art. 14 notice per language, null where it uses the default.
   *           properties:
   *             en: { type: string, nullable: true }
   *             cs: { type: string, nullable: true }
   *         defaults:
   *           type: object
   *           description: The product's default texts, with `{organization}` and `{period}` unfilled.
   *           properties:
   *             en: { type: string }
   *             cs: { type: string }
   *         period:
   *           type: object
   *           description: What `{period}` reads as, how long Contact is kept after an Employment ends.
   *           properties:
   *             en: { type: string }
   *             cs: { type: string }
   */

  /**
   * @openapi
   * /api/directory/{organizationId}/settings/general:
   *   get:
   *     tags:
   *       - Directory
   *     summary: The General tab of Directory settings
   *     description: |
   *       The Art. 14 notice shown under the emergency contacts to whoever
   *       edits them, in English and Czech: the organization's own text or the
   *       product default. `{organization}` becomes the organization's name and
   *       `{period}` how long Contact is kept after an Employment ends. The
   *       owner, org admins and HR read it.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: The General settings
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DirectoryGeneralSettings'
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, or `SETTINGS_DENIED` for anyone but the owner, org admins and HR"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF`"
   *   put:
   *     tags:
   *       - Directory
   *     summary: Change the Art. 14 notice
   *     description: |
   *       Sets the organization's own notice text per language. `null` goes back
   *       to the product default and a missing key leaves the text as it is.
   *       The owner and org admins only. Works on every plan.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             additionalProperties: false
   *             required: [emergencyContactNotice]
   *             properties:
   *               emergencyContactNotice:
   *                 type: object
   *                 additionalProperties: false
   *                 properties:
   *                   en:
   *                     type: string
   *                     nullable: true
   *                     minLength: 1
   *                     maxLength: 2000
   *                   cs:
   *                     type: string
   *                     nullable: true
   *                     minLength: 1
   *                     maxLength: 2000
   *     responses:
   *       '200':
   *         description: The General settings as saved
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DirectoryGeneralSettings'
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, `SETTINGS_DENIED`, or `SETTINGS_NOT_EDITABLE` for HR"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF`"
   *       '422':
   *         description: A malformed body
   */
  app.get("/:organizationId/settings/general", tryCatch(handleGetDirectoryGeneralSettings));
  app.put(
    "/:organizationId/settings/general",
    bodyValidationMiddleware(validatePutDirectoryGeneralSettings),
    tryCatch(handlePutDirectoryGeneralSettings)
  );

  /**
   * @openapi
   * components:
   *   schemas:
   *     RetentionPeriod:
   *       type: string
   *       enum: [AT_END, DAYS_30, MONTHS_6, YEAR_1, YEARS_3, YEARS_5, YEARS_10, UNTIL_ERASED]
   *       description: How long a Section is kept after an Employment ends, shortest first.
   *     RetentionPeriods:
   *       type: object
   *       required: [CARD, PHOTO, WORK_CONTACT, JOB, CONTACT, PERSONAL]
   *       properties:
   *         CARD: { $ref: '#/components/schemas/RetentionPeriod' }
   *         PHOTO: { $ref: '#/components/schemas/RetentionPeriod' }
   *         WORK_CONTACT: { $ref: '#/components/schemas/RetentionPeriod' }
   *         JOB: { $ref: '#/components/schemas/RetentionPeriod' }
   *         CONTACT: { $ref: '#/components/schemas/RetentionPeriod' }
   *         PERSONAL: { $ref: '#/components/schemas/RetentionPeriod' }
   *     RetentionSettings:
   *       type: object
   *       required: [editable, periods, defaults]
   *       properties:
   *         editable:
   *           type: boolean
   *           description: The caller is the owner or an org admin, who change these. HR reads them.
   *         periods:
   *           $ref: '#/components/schemas/RetentionPeriods'
   *         defaults:
   *           $ref: '#/components/schemas/RetentionPeriods'
   */

  /**
   * @openapi
   * /api/directory/{organizationId}/settings/retention:
   *   get:
   *     tags:
   *       - Directory
   *     summary: The organization's Retention periods
   *     description: |
   *       One Retention period per Section: how long it is kept after an
   *       Employment ends, counted from the later of the end date and the
   *       moment the ending was recorded. A Section the organization never
   *       set reads as the product default. The owner, org admins and HR read
   *       them; while the directory is off, the owner and org admins still read
   *       and change them, because the purges keep running.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: The Retention settings
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/RetentionSettings'
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, or `SETTINGS_DENIED` for anyone but the owner, org admins and HR"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF` for a caller other than the owner or an org admin: they reach this while the directory is off too"
   *   put:
   *     tags:
   *       - Directory
   *     summary: Change one Section's Retention period
   *     description: |
   *       Sets the period of one Section. It also applies to Employments that
   *       already ended: a shorter period removes what is past it at the next
   *       nightly run, and a longer one brings nothing back. The owner and org
   *       admins only. Works on every plan.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             additionalProperties: false
   *             required: [section, period]
   *             properties:
   *               section:
   *                 type: string
   *                 enum: [CARD, PHOTO, WORK_CONTACT, JOB, CONTACT, PERSONAL]
   *               period:
   *                 $ref: '#/components/schemas/RetentionPeriod'
   *     responses:
   *       '200':
   *         description: The Retention settings as saved
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/RetentionSettings'
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, `SETTINGS_DENIED`, or `SETTINGS_NOT_EDITABLE` for HR"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF` for a caller other than the owner or an org admin: they reach this while the directory is off too"
   *       '422':
   *         description: A malformed body, a period off the list, or a row that is not a Section
   */
  app.get("/:organizationId/settings/retention", tryCatch(handleGetRetentionSettings));
  app.put(
    "/:organizationId/settings/retention",
    bodyValidationMiddleware(validatePutRetentionPeriod),
    tryCatch(handlePutRetentionPeriod)
  );

  /**
   * @openapi
   * /api/directory/{organizationId}/settings/retention/preview:
   *   get:
   *     tags:
   *       - Directory
   *     summary: How many people a Retention period would remove
   *     description: |
   *       Counts the ended Employments that still hold the Section and would
   *       be past the given period at the next nightly run, for the dialog that
   *       confirms a shortening, once per person: per account, or per email for
   *       spells without one. Changes nothing. The owner and org admins only,
   *       with the directory on or off.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: section
   *         required: true
   *         schema:
   *           type: string
   *           enum: [CARD, PHOTO, WORK_CONTACT, JOB, CONTACT, PERSONAL]
   *       - in: query
   *         name: period
   *         required: true
   *         schema:
   *           $ref: '#/components/schemas/RetentionPeriod'
   *     responses:
   *       '200':
   *         description: The count
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [section, period, affected]
   *               properties:
   *                 section:
   *                   type: string
   *                 period:
   *                   $ref: '#/components/schemas/RetentionPeriod'
   *                 affected:
   *                   type: integer
   *                   description: People whose Section the next nightly run would remove under this period.
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, or `SETTINGS_NOT_EDITABLE` for anyone but the owner and org admins"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF` for a caller other than the owner or an org admin: they reach this while the directory is off too"
   *       '422':
   *         description: A missing or unknown section or period
   */
  app.get("/:organizationId/settings/retention/preview", tryCatch(handleGetRetentionPreview));

  /**
   * @openapi
   * components:
   *   schemas:
   *     PermissionTable:
   *       type: object
   *       required: [editable, writable, cells]
   *       properties:
   *         editable:
   *           type: boolean
   *           description: The caller is the owner, the only one who changes cells and roles.
   *         writable:
   *           type: boolean
   *           description: The plan passes the directory gate. While it doesn't, the owner may only narrow cells.
   *         cells:
   *           type: array
   *           description: |
   *             Every cell the table has. Act rows have no Self, Colleague or
   *             External worker cell, and End has no Group admin cell. A cell
   *             the organization's copy lacks reads as the product default.
   *           items:
   *             type: object
   *             required: [row, audience, value, fixed, options]
   *             properties:
   *               row:
   *                 type: string
   *                 enum: [CARD, PHOTO, WORK_CONTACT, JOB, CONTACT, PERSONAL, CREATE_ACCOUNTLESS_PERSON, SEND_DIRECTORY_INVITE, CHANGE_WORKER_TYPE, END_EMPLOYMENT, MANAGE_DEPARTMENTS_AND_LOCATIONS]
   *               audience:
   *                 type: string
   *                 enum: [OWNER, SELF, COLLEAGUE, EXTERNAL_WORKER, GROUP_ADMIN, HR, LEADERSHIP, ORGANIZATION_ADMIN]
   *               value:
   *                 type: string
   *                 enum: [NONE, READ, WRITE, ALLOWED, NO]
   *               fixed:
   *                 type: boolean
   *                 description: The Owner column, and Self on Card and Job.
   *               options:
   *                 type: array
   *                 description: The values the owner may set. Colleague and External worker offer NONE and READ, Self READ and WRITE, act cells NO and ALLOWED.
   *                 items:
   *                   type: string
   *                   enum: [NONE, READ, WRITE, ALLOWED, NO]
   *     DirectoryRoles:
   *       type: object
   *       required: [editable, writable, people]
   *       properties:
   *         editable:
   *           type: boolean
   *           description: The caller is the owner.
   *         writable:
   *           type: boolean
   *           description: The plan passes the directory gate. While it doesn't, roles can only be removed.
   *         people:
   *           type: array
   *           description: Every open Employment with a live account, by name, the only ones that may hold a role.
   *           items:
   *             type: object
   *             required: [employmentId, name, roles]
   *             properties:
   *               employmentId:
   *                 type: string
   *               name:
   *                 type: string
   *               roles:
   *                 type: array
   *                 items:
   *                   type: string
   *                   enum: [HR, LEADERSHIP]
   */

  /**
   * @openapi
   * /api/directory/{organizationId}/permissions:
   *   get:
   *     tags:
   *       - Directory
   *     summary: The organization's Permission table
   *     description: |
   *       Every cell with its value, whether it is fixed and which values the
   *       owner may set. The owner, org admins and HR read it; only the owner
   *       edits it. A lapsed plan keeps it readable.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: The table
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/PermissionTable'
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, or `PERMISSIONS_DENIED` for anyone but the owner, org admins and HR"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF`"
   *   patch:
   *     tags:
   *       - Directory
   *     summary: Change one cell of the Permission table
   *     description: |
   *       Owner only. The change applies at once, with no approval step, and
   *       writes one Permission history entry with the value before and after.
   *       Setting a cell to the value it holds changes nothing and writes no
   *       entry. While the plan is lapsed, a change that narrows the cell (a
   *       lower level, or allowed to no) goes through and one that widens it is
   *       refused.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             additionalProperties: false
   *             required: [row, audience, value]
   *             properties:
   *               row:
   *                 type: string
   *                 enum: [CARD, PHOTO, WORK_CONTACT, JOB, CONTACT, PERSONAL, CREATE_ACCOUNTLESS_PERSON, SEND_DIRECTORY_INVITE, CHANGE_WORKER_TYPE, END_EMPLOYMENT, MANAGE_DEPARTMENTS_AND_LOCATIONS]
   *               audience:
   *                 type: string
   *                 enum: [OWNER, SELF, COLLEAGUE, EXTERNAL_WORKER, GROUP_ADMIN, HR, LEADERSHIP, ORGANIZATION_ADMIN]
   *               value:
   *                 type: string
   *                 enum: [NONE, READ, WRITE, ALLOWED, NO]
   *     responses:
   *       '200':
   *         description: The table after the change
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/PermissionTable'
   *       '401':
   *         description: Not signed in
   *       '402':
   *         description: "`reason: PLAN_LIMIT`, `code: DIRECTORY_PLAN_REQUIRED`: the change widens a cell and the plan is not Enterprise or Custom"
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, or `OWNER_ONLY` for anyone but the owner"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF`"
   *       '422':
   *         description: |
   *           A malformed body, `NO_SUCH_CELL` (the table has no cell there),
   *           `CELL_FIXED` (the Owner column, Self on Card and Job) or
   *           `VALUE_NOT_OFFERED` (write for Colleague or External worker,
   *           none for Self, an act value on a Section or the reverse).
   */
  app.get("/:organizationId/permissions", tryCatch(handleGetPermissionTable));
  app.patch(
    "/:organizationId/permissions",
    bodyValidationMiddleware(validatePatchPermissionCell),
    tryCatch(handlePatchPermissionCell)
  );

  /**
   * @openapi
   * /api/directory/{organizationId}/permissions/history:
   *   get:
   *     tags:
   *       - Directory
   *     summary: The Permission history
   *     description: |
   *       Every change to the Permission table and to Directory roles, newest
   *       first. A `CELL` entry names the row, audience and the value before
   *       and after. A `ROLE` entry names the role, the person and whether
   *       they held it before and after, with the reason: the owner changed
   *       it, the Employment ended or the account was deleted. Kept for the
   *       organization's life; an erased person's entries stay with
   *       `employmentId` and `personName` null. The owner, org admins and HR.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: The entries
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 type: object
   *                 required: [kind, id, at, actorName, before, after]
   *                 properties:
   *                   kind:
   *                     type: string
   *                     enum: [CELL, ROLE]
   *                   id:
   *                     type: string
   *                   at:
   *                     type: string
   *                     format: date-time
   *                   actorName:
   *                     type: string
   *                     nullable: true
   *                     description: Null for a change nobody made by hand or once the actor's user row is gone.
   *                   row:
   *                     type: string
   *                     description: CELL only.
   *                   audience:
   *                     type: string
   *                     description: CELL only.
   *                   role:
   *                     type: string
   *                     enum: [HR, LEADERSHIP]
   *                     description: ROLE only.
   *                   employmentId:
   *                     type: string
   *                     nullable: true
   *                     description: ROLE only.
   *                   personName:
   *                     type: string
   *                     nullable: true
   *                     description: ROLE only.
   *                   before:
   *                     description: A cell value (CELL) or whether the role was held (ROLE).
   *                     oneOf:
   *                       - type: string
   *                       - type: boolean
   *                   after:
   *                     oneOf:
   *                       - type: string
   *                       - type: boolean
   *                   reason:
   *                     type: string
   *                     enum: [OWNER, EMPLOYMENT_ENDED, ACCOUNT_DELETED]
   *                     description: ROLE only.
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, or `PERMISSIONS_DENIED`"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF`"
   */
  app.get("/:organizationId/permissions/history", tryCatch(handleGetPermissionHistory));

  /**
   * @openapi
   * /api/directory/{organizationId}/checklist:
   *   get:
   *     tags:
   *       - Directory
   *     summary: The directory setup checklist
   *     description: |
   *       For the owner, org admins and HR. Each item ticks itself from the
   *       data: a Department that is not archived, a Location that is not
   *       archived, HR held on an open Employment, a job title on an open
   *       Profile. Assign HR and the "Review who sees what" link are the
   *       owner's only. `hidden` is true once someone clicked Hide since the
   *       latest enable, or once every item the viewer sees is done.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: The checklist
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DirectoryChecklist'
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, or `CHECKLIST_DENIED`"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF`"
   * components:
   *   schemas:
   *     DirectoryChecklist:
   *       type: object
   *       required: [hidden, items, reviewPermissions]
   *       properties:
   *         hidden:
   *           type: boolean
   *         items:
   *           type: array
   *           description: In this order; `hr` only for the owner.
   *           items:
   *             type: object
   *             required: [key, done]
   *             properties:
   *               key:
   *                 type: string
   *                 enum: [departments, locations, hr, jobTitles]
   *               done:
   *                 type: boolean
   *         reviewPermissions:
   *           type: boolean
   *           description: Show the owner's link to the Permission table.
   */
  app.get("/:organizationId/checklist", tryCatch(handleGetDirectoryChecklist));

  /**
   * @openapi
   * /api/directory/{organizationId}/checklist/hide:
   *   post:
   *     tags:
   *       - Directory
   *     summary: Hide the setup checklist for the organization
   *     description: |
   *       Anyone who sees the checklist hides it for everyone until the next
   *       enable. Never plan-gated.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: The checklist, now hidden
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DirectoryChecklist'
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, or `CHECKLIST_DENIED`"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF`"
   */
  app.post("/:organizationId/checklist/hide", tryCatch(handlePostHideDirectoryChecklist));

  /**
   * @openapi
   * /api/directory/{organizationId}/roles:
   *   get:
   *     tags:
   *       - Directory
   *     summary: Who holds the Directory roles
   *     description: |
   *       Every open Employment with a live account and the roles HR and
   *       Leadership it holds. The owner, org admins and HR.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: The people and their roles
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DirectoryRoles'
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, or `PERMISSIONS_DENIED`"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF`"
   */
  app.get("/:organizationId/roles", tryCatch(handleGetDirectoryRoles));

  /**
   * @openapi
   * /api/directory/{organizationId}/roles/{employmentId}:
   *   put:
   *     tags:
   *       - Directory
   *     summary: Set the Directory roles one person holds
   *     description: |
   *       Owner only. `roles` is the full set the Employment holds afterwards;
   *       one person may hold both. Only an open Employment with a live
   *       account may hold a role, and being an org admin brings none. Adding
   *       a role needs the directory plan; removing one works on every plan.
   *       Each role added or removed writes a Permission history entry.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: employmentId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             additionalProperties: false
   *             required: [roles]
   *             properties:
   *               roles:
   *                 type: array
   *                 maxItems: 2
   *                 items:
   *                   type: string
   *                   enum: [HR, LEADERSHIP]
   *     responses:
   *       '200':
   *         description: The people and their roles after the change
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DirectoryRoles'
   *       '401':
   *         description: Not signed in
   *       '402':
   *         description: "`reason: PLAN_LIMIT`, `code: DIRECTORY_PLAN_REQUIRED`: a role is added and the plan is not Enterprise or Custom"
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, or `OWNER_ONLY`"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`, or `PERSON_NOT_FOUND` for an Employment of another organization"
   *       '409':
   *         description: "`DIRECTORY_OFF`"
   *       '422':
   *         description: "A malformed body, or a role added to `NO_ACCOUNT`, `EMPLOYMENT_ENDED` or `ACCOUNT_DELETED` records"
   */
  app.put(
    "/:organizationId/roles/:employmentId",
    bodyValidationMiddleware(validatePutDirectoryRoles),
    tryCatch(handlePutDirectoryRoles)
  );

  /**
   * @openapi
   * components:
   *   schemas:
   *     ProfilePhotoUpload:
   *       type: object
   *       required: [id, status, rejectionReason]
   *       properties:
   *         id:
   *           type: string
   *           format: uuid
   *         status:
   *           type: string
   *           enum: [UPLOADING, READY, REJECTED]
   *         rejectionReason:
   *           type: string
   *           nullable: true
   *           enum: [TYPE_MISMATCH, IMAGE_UNREADABLE, null]
   */

  /**
   * @openapi
   * /api/directory/{organizationId}/people/{employmentId}/photo:
   *   post:
   *     tags:
   *       - Directory
   *     summary: Start uploading a Profile photo
   *     description: |
   *       Registers an upload and answers where the browser sends the bytes.
   *       Against S3 that is a presigned POST to the organization-data
   *       bucket's `incoming/` prefix (docs/adr/0003): post the `fields`
   *       first and the file last, named `file`. The disk store answers a
   *       signed PUT instead, which processes the bytes before it answers.
   *       The `attachment-processor` Lambda (or the disk store) rewrites the
   *       image into a small and a full JPEG without EXIF or GPS metadata,
   *       then the upload settles `READY` and replaces the previous photo,
   *       or `REJECTED`. Poll the status route meanwhile.
   *
   *       Needs a write cell on the Photo row: by default the person, HR and
   *       org admins, and only the admin columns while no account is bound.
   *       Setting a photo needs the directory plan. An earlier upload of the
   *       same person that has not settled is dropped.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - { in: path, name: organizationId, required: true, schema: { type: string } }
   *       - { in: path, name: employmentId, required: true, schema: { type: string } }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [contentType, size]
   *             properties:
   *               contentType:
   *                 type: string
   *                 description: image/png, image/jpeg, image/webp or image/heic.
   *               size:
   *                 type: integer
   *                 minimum: 1
   *                 description: Bytes; at most 10 MB.
   *     responses:
   *       '201':
   *         description: The upload and its target
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [photo, upload]
   *               properties:
   *                 photo:
   *                   $ref: '#/components/schemas/ProfilePhotoUpload'
   *                 upload:
   *                   type: object
   *                   required: [url, method, expiresAt]
   *                   properties:
   *                     url: { type: string }
   *                     method: { type: string, enum: [POST, PUT] }
   *                     fields:
   *                       type: object
   *                       additionalProperties: { type: string }
   *                       description: POST only, the signed form fields.
   *                     headers:
   *                       type: object
   *                       additionalProperties: { type: string }
   *                       description: PUT only.
   *                     expiresAt: { type: string, format: date-time }
   *       '401':
   *         description: Not signed in
   *       '402':
   *         description: "`reason: PLAN_LIMIT`, `code: DIRECTORY_PLAN_REQUIRED`: the plan is not Enterprise or Custom"
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, or `SECTION_NOT_WRITABLE` without a write cell on the Photo row"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`, or `PERSON_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF`"
   *       '422':
   *         description: "A malformed body, or `reason` `UNSUPPORTED_TYPE` or `FILE_TOO_LARGE`"
   *       '503':
   *         description: No organization-data store is configured
   *   delete:
   *     tags:
   *       - Directory
   *     summary: Remove the Profile photo
   *     description: |
   *       Removes the current photo and any upload in flight, and deletes
   *       both stored sizes. Works on every plan. Records a profile history
   *       entry when there was a photo. Answers 204 whether or not one existed.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - { in: path, name: organizationId, required: true, schema: { type: string } }
   *       - { in: path, name: employmentId, required: true, schema: { type: string } }
   *     responses:
   *       '204':
   *         description: No photo is left
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, or `SECTION_NOT_WRITABLE`"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`, or `PERSON_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF`"
   */
  app.post(
    "/:organizationId/people/:employmentId/photo",
    bodyValidationMiddleware(validatePostProfilePhoto),
    tryCatch(handlePostProfilePhoto)
  );
  app.delete("/:organizationId/people/:employmentId/photo", tryCatch(handleDeleteProfilePhoto));

  /**
   * @openapi
   * /api/directory/{organizationId}/people/{employmentId}/photo/{photoId}:
   *   get:
   *     tags:
   *       - Directory
   *     summary: How a Profile photo upload stands
   *     description: The writer polls this after sending the bytes, until the upload settles.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - { in: path, name: organizationId, required: true, schema: { type: string } }
   *       - { in: path, name: employmentId, required: true, schema: { type: string } }
   *       - { in: path, name: photoId, required: true, schema: { type: string } }
   *     responses:
   *       '200':
   *         description: The upload
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ProfilePhotoUpload'
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, or `SECTION_NOT_WRITABLE`"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`, `PERSON_NOT_FOUND`, or `PHOTO_NOT_FOUND` once it was replaced, removed or dropped"
   *       '409':
   *         description: "`DIRECTORY_OFF`"
   */
  app.get(
    "/:organizationId/people/:employmentId/photo/:photoId",
    tryCatch(handleGetProfilePhotoStatus)
  );

  return app;
};
