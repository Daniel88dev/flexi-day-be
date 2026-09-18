import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetSyncPull } from "../controllers/sync/handleGetSyncPull.js";

export const syncRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/sync/pull:
   *   get:
   *     tags:
   *       - Sync
   *     summary: Every row the caller may see, for a client-side store
   *     description: |
   *       Feeds the phone app's local copy of what the caller can see on the
   *       web. One envelope carries every table in dependency order, so a
   *       client can apply the payload top to bottom: `organizations`,
   *       `users`, `groups`, `groupUsers`, `groupMirrors`, `userYearQuotas`,
   *       `bankHolidays`, `vacations`. Rows are raw table rows with camelCase
   *       keys matching the database columns and timestamps as ISO 8601 UTC;
   *       no joined summaries and no per-row verdicts. Every partitioned row
   *       carries `organizationId`.
   *
   *       Scope is membership-only, exactly the web dashboard and calendar. A
   *       group where the caller has view access, admin access, or is the
   *       manager returns its full live member list; a group where they are a
   *       plain member returns only their own membership row. A group the
   *       caller only administers as an org admin is not included.
   *
   *       A pull without a cursor is a sync reset: `reset` is `true` and the
   *       response is a full snapshot rather than a delta. The `cursor` in the
   *       response is opaque and versioned — the client stores it verbatim,
   *       never parses it, and sends it back on the next pull. Cursors are
   *       minted but not read back yet, so every pull answers a sync reset,
   *       `hasMore` is always `false`, and the tables this endpoint does not
   *       fill yet — `users`, `groupMirrors`, `userYearQuotas`,
   *       `bankHolidays` and `vacations` — arrive as empty arrays.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: cursor
   *         in: query
   *         required: false
   *         description: |
   *           The opaque cursor from a previous pull. Never rejected: a cursor
   *           the server cannot use answers with a sync reset.
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: One page of the caller's rows
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required:
   *                 - cursor
   *                 - hasMore
   *                 - reset
   *                 - organizations
   *                 - users
   *                 - groups
   *                 - groupUsers
   *                 - groupMirrors
   *                 - userYearQuotas
   *                 - bankHolidays
   *                 - vacations
   *               properties:
   *                 cursor:
   *                   type: string
   *                   description: Opaque position to send on the next pull
   *                 hasMore:
   *                   type: boolean
   *                   description: True when another page of this pull is waiting
   *                 reset:
   *                   type: boolean
   *                   description: True when the payload is a full snapshot rather than a delta
   *                 organizations:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       id:
   *                         type: string
   *                       name:
   *                         type: string
   *                 users:
   *                   type: array
   *                   items:
   *                     type: object
   *                 groups:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       id:
   *                         type: string
   *                       organizationId:
   *                         type: string
   *                       groupName:
   *                         type: string
   *                       defaultVacationDays:
   *                         type: integer
   *                       defaultHomeOfficeDays:
   *                         type: integer
   *                       defaultSickDays:
   *                         type: integer
   *                       workingDays:
   *                         type: array
   *                         items:
   *                           type: integer
   *                       holidayCountry:
   *                         type: string
   *                         nullable: true
   *                       managerUserId:
   *                         type: string
   *                       mainApprovalUser:
   *                         type: string
   *                         nullable: true
   *                       tempApprovalUser:
   *                         type: string
   *                         nullable: true
   *                       deletedAt:
   *                         type: string
   *                         format: date-time
   *                         nullable: true
   *                       createdAt:
   *                         type: string
   *                         format: date-time
   *                       updatedAt:
   *                         type: string
   *                         format: date-time
   *                 groupUsers:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       id:
   *                         type: string
   *                       groupId:
   *                         type: string
   *                       organizationId:
   *                         type: string
   *                       userId:
   *                         type: string
   *                       viewAccess:
   *                         type: boolean
   *                       adminAccess:
   *                         type: boolean
   *                       approverAccess:
   *                         type: boolean
   *                       controlledUser:
   *                         type: boolean
   *                       deletedAt:
   *                         type: string
   *                         format: date-time
   *                         nullable: true
   *                       createdAt:
   *                         type: string
   *                         format: date-time
   *                       updatedAt:
   *                         type: string
   *                         format: date-time
   *                 groupMirrors:
   *                   type: array
   *                   items:
   *                     type: object
   *                 userYearQuotas:
   *                   type: array
   *                   items:
   *                     type: object
   *                 bankHolidays:
   *                   type: array
   *                   items:
   *                     type: object
   *                 vacations:
   *                   type: array
   *                   items:
   *                     type: object
   *       '401':
   *         description: Unauthorized - missing or invalid authentication
   */
  app.get("/pull", tryCatch(handleGetSyncPull));

  return app;
};
