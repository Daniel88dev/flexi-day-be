import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import { validatePatchDirectoryProfile } from "../services/directory/types.js";
import { handleGetProfileHistory } from "../controllers/directory/handleGetProfileHistory.js";
import { handlePatchDirectoryProfile } from "../controllers/directory/handlePatchDirectoryProfile.js";
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
   *       enum: [EXTERNAL_WORKER, NO_ACCOUNT, ACCOUNT_DELETED, REJOINED]
   *       description: |
   *         Badges on a row. Everyone who reaches the record sees
   *         EXTERNAL_WORKER. NO_ACCOUNT, ACCOUNT_DELETED and REJOINED (an
   *         ended spell whose person started a later one) go to the owner,
   *         org admins and HR only.
   *     DirectoryPerson:
   *       type: object
   *       required: [employmentId, name, jobTitle, image, user, markers]
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
   *         image:
   *           type: string
   *           nullable: true
   *           description: The Account picture, for the avatar fallback.
   *         user:
   *           type: object
   *           description: Initials and avatar colour, keyed on the user or, without an account, the Employment.
   *           properties:
   *             id: { type: string }
   *             name: { type: string }
   *             initials: { type: string }
   *             avatarColor: { type: string }
   *         markers:
   *           type: array
   *           items:
   *             $ref: '#/components/schemas/DirectoryMarker'
   *     DirectorySectionView:
   *       type: object
   *       required: [level]
   *       properties:
   *         level:
   *           type: string
   *           enum: [READ, WRITE]
   *     DirectoryCardView:
   *       allOf:
   *         - $ref: '#/components/schemas/DirectorySectionView'
   *         - type: object
   *           required: [jobTitle, reportsTo, nameFromAccount]
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
   *     DirectoryProfile:
   *       allOf:
   *         - $ref: '#/components/schemas/DirectoryPerson'
   *         - type: object
   *           required: [organizationId, self, ended, sections, canReadHistory]
   *           properties:
   *             organizationId:
   *               type: string
   *             self:
   *               type: boolean
   *               description: The record is the caller's own.
   *             ended:
   *               type: boolean
   *             canReadHistory:
   *               type: boolean
   *               description: The caller is the owner, an org admin or HR.
   *             sections:
   *               type: object
   *               properties:
   *                 card:
   *                   $ref: '#/components/schemas/DirectoryCardView'
   *                 photo:
   *                   $ref: '#/components/schemas/DirectorySectionView'
   *                 workContact:
   *                   $ref: '#/components/schemas/DirectorySectionView'
   *                 job:
   *                   $ref: '#/components/schemas/DirectoryJobView'
   *                 contact:
   *                   $ref: '#/components/schemas/DirectorySectionView'
   *                 personal:
   *                   $ref: '#/components/schemas/DirectorySectionView'
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
   *       the Former list (the owner, org admins and HR).
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
   *               required: [people, formerList]
   *               properties:
   *                 people:
   *                   type: array
   *                   items:
   *                     $ref: '#/components/schemas/DirectoryPerson'
   *                 formerList:
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
   * /api/directory/{organizationId}/former:
   *   get:
   *     tags:
   *       - Directory
   *     summary: The Former list of an organization
   *     description: |
   *       One row per ended Employment spell whose Card the caller reads,
   *       latest end first. Only the owner, org admins and HR see it. A lapsed
   *       plan keeps this readable.
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
   *                     required: [startedAt, endedAt]
   *                     properties:
   *                       startedAt:
   *                         type: string
   *                         format: date-time
   *                       endedAt:
   *                         type: string
   *                         format: date-time
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
   *       they can't read is absent. Contact and Personal carry no values here.
   *       The spell dates sit in `job`, so only Job readers get them.
   *       `account` (status, sign-in email, directory roles) is present for
   *       the owner, org admins, HR and the person. An ended record is reached
   *       only by the owner, org admins and HR. A lapsed plan keeps this
   *       readable.
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
   *     summary: Edit the Card and Job Sections of a profile
   *     description: |
   *       Sets or clears Card and Job fields of one Employment, open or ended.
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
   *       Setting any value needs the directory plan (Enterprise or Custom).
   *       A body that only clears works on every plan. Contract type, working
   *       time and probation end date apply to employees only. The employee
   *       number is unique, ignoring case, among the organization's open
   *       Employments.
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
   *         description: "`DIRECTORY_OFF`, or `EMPLOYEE_NUMBER_TAKEN` when another open Employment holds the number"
   *       '422':
   *         description: |
   *           A malformed body, or `EMPLOYEES_ONLY` (an employee-only field set
   *           on an External worker), `PROBATION_BEFORE_START`,
   *           `REPORTS_TO_NOT_FOUND` (not an open Employment of the
   *           organization) or `REPORTS_TO_SELF`.
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
   *       Never the values. The owner, org admins and HR only. A lapsed plan
   *       keeps this readable.
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
   *                 required: [id, at, actorName, section, fields, audience]
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
   *                   audience:
   *                     type: string
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

  return app;
};
