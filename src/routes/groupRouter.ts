import { Router } from "express";
import { handlePostGroup } from "../controllers/group/handlePostGroup.js";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetGroups } from "../controllers/group/handleGetGroups.js";
import { handleGetGroup } from "../controllers/group/handleGetGroup.js";
import { handlePutGroupQuotas } from "../controllers/group/handlePutGroupQuotas.js";
import { handlePutGroupWorkingDays } from "../controllers/group/handlePutGroupWorkingDays.js";
import { handlePutGroupHolidayCountry } from "../controllers/group/handlePutGroupHolidayCountry.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import {
  validatePutGroupApprovers,
  validatePutGroupHolidayCountry,
  validatePutGroupQuotas,
  validatePutGroupWorkingDays,
} from "../services/group/types.js";
import { handlePutGroupApprovers } from "../controllers/group/handlePutGroupApprovers.js";
import { validatePutGroupMirrors } from "../services/groupMirror/types.js";
import { handleGetGroupMirrors } from "../controllers/group/handleGetGroupMirrors.js";
import { handlePutGroupMirrors } from "../controllers/group/handlePutGroupMirrors.js";

export const groupRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/group:
   *   post:
   *     tags:
   *       - Groups
   *     summary: Create a group
   *     description: |
   *       Creates a group owned by the caller's organization, adds the caller
   *       as its first member (admin + approver) and opens their current-year
   *       quota from the group defaults. The organization is created lazily on
   *       the caller's first group. An approver may only be named if it is the
   *       caller, since nobody else is a member yet.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - groupName
   *             properties:
   *               groupName:
   *                 type: string
   *                 minLength: 1
   *                 maxLength: 120
   *               defaultVacation:
   *                 type: integer
   *                 minimum: 0
   *                 maximum: 99
   *               defaultHomeOffice:
   *                 type: integer
   *                 minimum: 0
   *                 maximum: 99
   *               mainApprovalUser:
   *                 type: string
   *     responses:
   *       '201':
   *         description: The created group
   *       '402':
   *         description: |
   *           Plan limit reached, or the group is read-only because the plan
   *           lapsed. `errors[].context` carries
   *           `{ reason: "PLAN_LIMIT" | "READ_ONLY", limit, current }`.
   *       '422':
   *         description: A named approver is not the caller
   */
  app.post("/", tryCatch(handlePostGroup));

  app.get("/", tryCatch(handleGetGroups));

  /**
   * @openapi
   * /api/group/{groupId}:
   *   get:
   *     tags:
   *       - Groups
   *     summary: One group with the caller's effective rights over it
   *     description: |
   *       Unlike `GET /api/group` — which is membership-only, because it also
   *       drives the dashboard and the request dialog — this reaches groups the
   *       caller administers through the organization. `access` reports exactly
   *       what the mutation endpoints will allow, and `access.viaOrgAdmin`
   *       marks authority that came from the organization rather than a
   *       membership.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: groupId
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     responses:
   *       '200':
   *         description: The group, its organization badge and the caller's access
   *       '403':
   *         description: No access for related group
   *       '404':
   *         description: Group not found
   */
  app.get("/:groupId", tryCatch(handleGetGroup));

  /**
   * @openapi
   * /api/group/{groupId}/quotas:
   *   put:
   *     tags:
   *       - Groups
   *     summary: Update the group's default allowances
   *     description: |
   *       Sets the vacation / home-office days new members start from. Existing
   *       per-year quotas are not touched. Requires group admin access, or admin of the group's organization.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: groupId
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - defaultVacationDays
   *               - defaultHomeOfficeDays
   *             properties:
   *               defaultVacationDays:
   *                 type: integer
   *               defaultHomeOfficeDays:
   *                 type: integer
   *     responses:
   *       '200':
   *         description: The updated group
   *       '402':
   *         description: |
   *           Plan limit reached, or the group is read-only because the plan
   *           lapsed. `errors[].context` carries
   *           `{ reason: "PLAN_LIMIT" | "READ_ONLY", limit, current }`.
   *       '403':
   *         description: No permission for related group
   *       '404':
   *         description: Group not found
   */
  app.put(
    "/:groupId/quotas",
    bodyValidationMiddleware(validatePutGroupQuotas),
    tryCatch(handlePutGroupQuotas)
  );

  /**
   * @openapi
   * /api/group/{groupId}/working-days:
   *   put:
   *     tags:
   *       - Groups
   *     summary: Set the group's working days
   *     description: |
   *       Sets which weekdays the group treats as working days. Vacation
   *       requests are only booked — and only counted against quotas — on these
   *       days. Days are `Date.getUTCDay()` numbers (0=Sunday … 6=Saturday); at
   *       least one is required. Requires group admin access, or admin of the group's organization.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: groupId
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - workingDays
   *             properties:
   *               workingDays:
   *                 type: array
   *                 minItems: 1
   *                 maxItems: 7
   *                 items:
   *                   type: integer
   *                   minimum: 0
   *                   maximum: 6
   *     responses:
   *       '200':
   *         description: The updated group
   *       '402':
   *         description: |
   *           Plan limit reached, or the group is read-only because the plan
   *           lapsed. `errors[].context` carries
   *           `{ reason: "PLAN_LIMIT" | "READ_ONLY", limit, current }`.
   *       '403':
   *         description: No permission for related group
   *       '404':
   *         description: Group not found
   */
  app.put(
    "/:groupId/working-days",
    bodyValidationMiddleware(validatePutGroupWorkingDays),
    tryCatch(handlePutGroupWorkingDays)
  );

  /**
   * @openapi
   * /api/group/{groupId}/holiday-country:
   *   put:
   *     tags:
   *       - Groups
   *     summary: Set the group's public holiday country
   *     description: |
   *       Sets the country whose public holidays are shown on the dashboard
   *       calendar for everyone in the group. Holidays are display-only: they
   *       are not counted against quotas and are never exported by calendar
   *       feeds. `null` disables them. Codes are ISO 3166-1 alpha-2 and must
   *       be one of `GET /api/bank-holidays/countries`. Requires group admin
   *       access, or admin of the group's organization.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: groupId
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - holidayCountry
   *             properties:
   *               holidayCountry:
   *                 type: string
   *                 nullable: true
   *                 minLength: 2
   *                 maxLength: 2
   *                 example: CZ
   *     responses:
   *       '200':
   *         description: The updated group
   *       '402':
   *         description: |
   *           Plan limit reached, or the group is read-only because the plan
   *           lapsed. `errors[].context` carries
   *           `{ reason: "PLAN_LIMIT" | "READ_ONLY", limit, current }`.
   *       '403':
   *         description: No permission for related group
   *       '404':
   *         description: Group not found
   *       '422':
   *         description: Unsupported country code
   */
  app.put(
    "/:groupId/holiday-country",
    bodyValidationMiddleware(validatePutGroupHolidayCountry),
    tryCatch(handlePutGroupHolidayCountry)
  );

  /**
   * @openapi
   * /api/group/{groupId}/mirrors:
   *   get:
   *     tags:
   *       - Groups
   *     summary: The mirroring setup for this group
   *     description: |
   *       For a group admin, every member together with the source groups their
   *       records may be projected from — the groups the acting admin also
   *       administers and the member belongs to — and whether each is currently
   *       mirrored. A candidate with `manageable: false` is an active mirror
   *       from a group the caller does not administer: shown for completeness,
   *       not theirs to change. For anyone else, `canManage` is false and the
   *       response carries only their own mirrors, read-only.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: groupId
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     responses:
   *       '200':
   *         description: Members with their candidate source groups
   *       '403':
   *         description: Caller does not belong to the group
   *   put:
   *     tags:
   *       - Groups
   *     summary: Set which groups a member is mirrored from into this one
   *     description: |
   *       Replaces one member's mirror sources for this group, within the
   *       sources the caller administers — mirrors from other groups are left
   *       untouched. Mirrored records are shown here read-only: they are
   *       approved, counted against quotas and reported in their source group
   *       alone, and never need a decision in this one. Requires admin access on
   *       the target group and on every source group named, and the member must
   *       belong to all of them. An empty array turns the caller's manageable
   *       mirrors off.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: groupId
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - userId
   *               - sourceGroupIds
   *             properties:
   *               userId:
   *                 type: string
   *               sourceGroupIds:
   *                 type: array
   *                 items:
   *                   type: string
   *                   format: uuid
   *     responses:
   *       '200':
   *         description: The member's mirrors into this group after the update
   *       '402':
   *         description: |
   *           Plan limit reached, or the group is read-only because the plan
   *           lapsed. `errors[].context` carries
   *           `{ reason: "PLAN_LIMIT" | "READ_ONLY", limit, current }`.
   *       '403':
   *         description: Caller is not an admin of the target or of a source group
   *       '422':
   *         description: A group cannot mirror itself, or the member does not belong to a named group
   */
  /**
   * @openapi
   * /api/group/{groupId}/approvers:
   *   put:
   *     tags:
   *       - Groups
   *     summary: Set who decides on the group's leave requests
   *     description: |
   *       Names the main and optional stand-in approver. Both must already be
   *       members of the group. A group always has a main approver — clearing it
   *       would leave its requests undecidable. Requires group admin access, or admin of the group's organization.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: groupId
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - mainApprovalUser
   *             properties:
   *               mainApprovalUser:
   *                 type: string
   *               tempApprovalUser:
   *                 type: string
   *                 nullable: true
   *     responses:
   *       '200':
   *         description: The updated group
   *       '402':
   *         description: |
   *           Plan limit reached, or the group is read-only because the plan
   *           lapsed. `errors[].context` carries
   *           `{ reason: "PLAN_LIMIT" | "READ_ONLY", limit, current }`.
   *       '403':
   *         description: |
   *           No permission for related group; or a caller acting on
   *           organization authority named themselves as an approver.
   *       '404':
   *         description: Group not found
   *       '422':
   *         description: A named approver does not belong to the group
   */
  app.put(
    "/:groupId/approvers",
    bodyValidationMiddleware(validatePutGroupApprovers),
    tryCatch(handlePutGroupApprovers)
  );

  app.get("/:groupId/mirrors", tryCatch(handleGetGroupMirrors));
  app.put(
    "/:groupId/mirrors",
    bodyValidationMiddleware(validatePutGroupMirrors),
    tryCatch(handlePutGroupMirrors)
  );

  return app;
};
