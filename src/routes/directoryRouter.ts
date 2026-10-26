import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
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
   *       required: [employmentId, name, image, user, markers]
   *       properties:
   *         employmentId:
   *           type: string
   *         name:
   *           type: string
   *           description: The account's name while bound, otherwise the Employment's copy.
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
   *               allOf:
   *                 - $ref: '#/components/schemas/DirectoryPerson'
   *                 - type: object
   *                   required: [organizationId, self, ended, sections]
   *                   properties:
   *                     organizationId:
   *                       type: string
   *                     self:
   *                       type: boolean
   *                       description: The record is the caller's own.
   *                     ended:
   *                       type: boolean
   *                     sections:
   *                       type: object
   *                       properties:
   *                         card:
   *                           $ref: '#/components/schemas/DirectorySectionView'
   *                         photo:
   *                           $ref: '#/components/schemas/DirectorySectionView'
   *                         workContact:
   *                           $ref: '#/components/schemas/DirectorySectionView'
   *                         job:
   *                           allOf:
   *                             - $ref: '#/components/schemas/DirectorySectionView'
   *                             - type: object
   *                               required: [spell]
   *                               properties:
   *                                 spell:
   *                                   type: object
   *                                   properties:
   *                                     startedAt:
   *                                       type: string
   *                                       format: date-time
   *                                     endedAt:
   *                                       type: string
   *                                       format: date-time
   *                                       nullable: true
   *                         contact:
   *                           $ref: '#/components/schemas/DirectorySectionView'
   *                         personal:
   *                           $ref: '#/components/schemas/DirectorySectionView'
   *                     account:
   *                       type: object
   *                       properties:
   *                         status:
   *                           type: string
   *                           enum: [ACTIVE, NO_ACCOUNT, DELETED]
   *                         signInEmail:
   *                           type: string
   *                           nullable: true
   *                         directoryRoles:
   *                           type: array
   *                           items:
   *                             type: string
   *                             enum: [HR, LEADERSHIP]
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

  return app;
};
