import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import { directoryListHandlers } from "../controllers/directory/directoryListHandlers.js";
import {
  validatePatchDepartment,
  validatePatchLocation,
  validatePostDepartment,
  validatePostLocation,
} from "../services/directory/types.js";

/** The Department and Location lists of a Directory organization, under `/api/directory`. */
export const directoryListRouter = (): Router => {
  const app = Router();
  const departments = directoryListHandlers("departments");
  const locations = directoryListHandlers("locations");

  /**
   * @openapi
   * components:
   *   schemas:
   *     DirectoryEntryRef:
   *       type: object
   *       required: [id, name, archived]
   *       description: A Department or Location as a record holds it.
   *       properties:
   *         id:
   *           type: string
   *         name:
   *           type: string
   *         archived:
   *           type: boolean
   *           description: Archived entries stay on the records that hold them; clients show "Name (archived)".
   *     DirectoryDepartment:
   *       type: object
   *       required: [id, name, archived]
   *       properties:
   *         id:
   *           type: string
   *         name:
   *           type: string
   *         archived:
   *           type: boolean
   *         inUse:
   *           type: boolean
   *           description: |
   *             A Profile, open or former, holds the entry, so it can be
   *             archived but not deleted. Sent only to callers who manage the lists.
   *     DirectoryLocation:
   *       allOf:
   *         - $ref: '#/components/schemas/DirectoryDepartment'
   *         - type: object
   *           required: [country]
   *           properties:
   *             country:
   *               nullable: true
   *               description: The phone picker's default for the people it holds. Never drives holidays, working days or attendance.
   *               allOf:
   *                 - $ref: '#/components/schemas/DirectoryCountry'
   *     DirectoryDepartmentList:
   *       type: object
   *       required: [editable, writable, entries]
   *       properties:
   *         editable:
   *           type: boolean
   *           description: The Manage departments and locations act cell allows the caller.
   *         writable:
   *           type: boolean
   *           description: The plan passes the directory gate. While lapsed nothing can be added or restored.
   *         entries:
   *           type: array
   *           description: Every entry, archived ones included, by name.
   *           items:
   *             $ref: '#/components/schemas/DirectoryDepartment'
   *     DirectoryLocationList:
   *       type: object
   *       required: [editable, writable, entries]
   *       properties:
   *         editable:
   *           type: boolean
   *         writable:
   *           type: boolean
   *         entries:
   *           type: array
   *           items:
   *             $ref: '#/components/schemas/DirectoryLocation'
   */

  /**
   * @openapi
   * /api/directory/{organizationId}/departments:
   *   get:
   *     tags:
   *       - Directory
   *     summary: The organization's Department list
   *     description: |
   *       Every Department, archived ones included, by name. Anyone in the
   *       directory reads it: Card writers pick from it and the directory
   *       filters by it. `inUse` goes only to callers the Manage departments
   *       and locations act cell allows.
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
   *         description: The list
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DirectoryDepartmentList'
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF`"
   *   post:
   *     tags:
   *       - Directory
   *     summary: Add a Department
   *     description: |
   *       Needs the Manage departments and locations act cell (the owner
   *       always; HR and org admins by default) and the directory plan.
   *       Names are unique within the list, ignoring case, archived entries
   *       included.
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
   *             required: [name]
   *             properties:
   *               name:
   *                 type: string
   *                 minLength: 1
   *                 maxLength: 100
   *                 description: Trimmed.
   *     responses:
   *       '201':
   *         description: The new entry
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DirectoryDepartment'
   *       '401':
   *         description: Not signed in
   *       '402':
   *         description: "`reason: PLAN_LIMIT`, `code: DIRECTORY_PLAN_REQUIRED`: the plan is not Enterprise or Custom"
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`, or `LISTS_DENIED` when the act cell doesn't allow the caller"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF`, or `NAME_TAKEN`"
   *       '422':
   *         description: A malformed body
   */
  app.get("/:organizationId/departments", tryCatch(departments.list));
  app.post(
    "/:organizationId/departments",
    bodyValidationMiddleware(validatePostDepartment),
    tryCatch(departments.add)
  );

  /**
   * @openapi
   * /api/directory/{organizationId}/departments/{entryId}:
   *   patch:
   *     tags:
   *       - Directory
   *     summary: Rename, archive or restore a Department
   *     description: |
   *       Renaming and archiving work on every plan. Restoring an archived
   *       entry needs the directory plan. An archived entry leaves the
   *       pickers and stays on the records that hold it. Needs the Manage
   *       departments and locations act cell.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: entryId
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
   *             minProperties: 1
   *             properties:
   *               name:
   *                 type: string
   *                 minLength: 1
   *                 maxLength: 100
   *               archived:
   *                 type: boolean
   *     responses:
   *       '200':
   *         description: The entry
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DirectoryDepartment'
   *       '401':
   *         description: Not signed in
   *       '402':
   *         description: "`reason: PLAN_LIMIT`: restoring on a lapsed plan"
   *       '403':
   *         description: "`NOT_IN_DIRECTORY` or `LISTS_DENIED`"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND` or `ENTRY_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF` or `NAME_TAKEN`"
   *       '422':
   *         description: A malformed body
   *   delete:
   *     tags:
   *       - Directory
   *     summary: Delete an unused Department
   *     description: |
   *       Only while no Profile, open or former, holds it; otherwise archive
   *       it. Works on every plan. Needs the Manage departments and
   *       locations act cell.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: entryId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '204':
   *         description: Deleted
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY` or `LISTS_DENIED`"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND` or `ENTRY_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF`, or `ENTRY_IN_USE` when a record holds the entry"
   */
  app.patch(
    "/:organizationId/departments/:entryId",
    bodyValidationMiddleware(validatePatchDepartment),
    tryCatch(departments.update)
  );
  app.delete("/:organizationId/departments/:entryId", tryCatch(departments.remove));

  /**
   * @openapi
   * /api/directory/{organizationId}/locations:
   *   get:
   *     tags:
   *       - Directory
   *     summary: The organization's Location list
   *     description: |
   *       Every Location, archived ones included, by name, with its country
   *       named in the caller's language. Anyone in the directory reads it.
   *       `inUse` goes only to callers the Manage departments and locations
   *       act cell allows.
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
   *         description: The language of country names. Defaults to the caller's stored language, then English.
   *         schema:
   *           type: string
   *           enum: [en, cs]
   *     responses:
   *       '200':
   *         description: The list
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DirectoryLocationList'
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY`"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF`"
   *   post:
   *     tags:
   *       - Directory
   *     summary: Add a Location
   *     description: |
   *       Needs the Manage departments and locations act cell and the
   *       directory plan. Names are unique within the list, ignoring case,
   *       archived entries included. The optional country starts the phone
   *       picker for the people the Location holds and drives nothing else.
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
   *                 maxLength: 100
   *               country:
   *                 type: string
   *                 nullable: true
   *                 description: ISO 3166-1 alpha-2, any case.
   *     responses:
   *       '201':
   *         description: The new entry
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DirectoryLocation'
   *       '401':
   *         description: Not signed in
   *       '402':
   *         description: "`reason: PLAN_LIMIT`, `code: DIRECTORY_PLAN_REQUIRED`"
   *       '403':
   *         description: "`NOT_IN_DIRECTORY` or `LISTS_DENIED`"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF` or `NAME_TAKEN`"
   *       '422':
   *         description: A malformed body, or `INVALID_COUNTRY`
   */
  app.get("/:organizationId/locations", tryCatch(locations.list));
  app.post(
    "/:organizationId/locations",
    bodyValidationMiddleware(validatePostLocation),
    tryCatch(locations.add)
  );

  /**
   * @openapi
   * /api/directory/{organizationId}/locations/{entryId}:
   *   patch:
   *     tags:
   *       - Directory
   *     summary: Rename, archive or restore a Location, or change its country
   *     description: |
   *       Renaming, archiving and clearing the country work on every plan.
   *       Restoring an archived entry or setting a country needs the
   *       directory plan. Needs the Manage departments and locations act cell.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: entryId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: language
   *         required: false
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
   *             minProperties: 1
   *             properties:
   *               name:
   *                 type: string
   *                 minLength: 1
   *                 maxLength: 100
   *               archived:
   *                 type: boolean
   *               country:
   *                 type: string
   *                 nullable: true
   *                 description: ISO 3166-1 alpha-2; null clears it.
   *     responses:
   *       '200':
   *         description: The entry
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DirectoryLocation'
   *       '401':
   *         description: Not signed in
   *       '402':
   *         description: "`reason: PLAN_LIMIT`: restoring or setting a country on a lapsed plan"
   *       '403':
   *         description: "`NOT_IN_DIRECTORY` or `LISTS_DENIED`"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND` or `ENTRY_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF` or `NAME_TAKEN`"
   *       '422':
   *         description: A malformed body, or `INVALID_COUNTRY`
   *   delete:
   *     tags:
   *       - Directory
   *     summary: Delete an unused Location
   *     description: |
   *       Only while no Profile, open or former, holds it; otherwise archive
   *       it. Works on every plan. Needs the Manage departments and
   *       locations act cell.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: entryId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '204':
   *         description: Deleted
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: "`NOT_IN_DIRECTORY` or `LISTS_DENIED`"
   *       '404':
   *         description: "`ORGANIZATION_NOT_FOUND` or `ENTRY_NOT_FOUND`"
   *       '409':
   *         description: "`DIRECTORY_OFF`, or `ENTRY_IN_USE` when a record holds the entry"
   */
  app.patch(
    "/:organizationId/locations/:entryId",
    bodyValidationMiddleware(validatePatchLocation),
    tryCatch(locations.update)
  );
  app.delete("/:organizationId/locations/:entryId", tryCatch(locations.remove));

  return app;
};
