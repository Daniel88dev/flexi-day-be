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
   *       manager returns its whole member list; a group where they are a plain
   *       member returns only their own membership row. A group the caller only
   *       administers as an org admin is not included.
   *
   *       The `cursor` in the response is opaque and versioned — the client
   *       stores it verbatim, never parses it, and sends it back on the next
   *       pull. Its position is minted when the pull starts, before any row is
   *       read, so consecutive pulls chain and a change landing mid-read falls
   *       to the next pull rather than between the two.
   *
   *       A pull carrying a cursor answers a delta: `reset` is `false` and each
   *       table holds only the rows whose `updatedAt` is later than the cursor
   *       time minus 60 seconds and no later than the position this pull was
   *       minted with, ordered by `updatedAt` then `id`.
   *       `organizations` names the organization of every group in the delta.
   *       The 60 second overlap covers the clock difference between the
   *       database, which stamps inserts, and the server instance that stamps
   *       an update, so the same row may arrive on two consecutive pulls; a
   *       client applies rows as upserts and the second delivery changes
   *       nothing.
   *
   *       A soft-deleted row arrives in a delta as a tombstone: the whole row
   *       with `deletedAt` set, so the client can drop its copy. A delta
   *       tombstones a group the caller still belongs to and, in a group they
   *       see in full, the membership of anyone who left it. The caller's own
   *       removal takes the group out of scope instead of tombstoning it. A
   *       snapshot holds live membership rows only — the client sweeps whatever
   *       the snapshot did not re-send.
   *
   *       A pull answers a sync reset — `reset` is `true` and the payload is a
   *       full snapshot rather than a delta — when the request carries no
   *       cursor, a cursor the server cannot decode, a cursor minted by another
   *       cursor version, a cursor whose time is more than 30 days old, a
   *       cursor whose time is more than 60 seconds ahead of the server clock,
   *       a cursor whose paging state the server cannot resume, or anything
   *       else it cannot read as one cursor, such as the parameter repeated. A
   *       cursor is never rejected with an error, and an unusable one mid-loop
   *       restarts the loop as a fresh snapshot.
   *
   *       A pull is paged at a fixed 1000 rows across all tables, and there is
   *       no `limit` parameter. When more rows are waiting, `hasMore` is `true`
   *       and the same opaque `cursor` also carries the table the page stopped
   *       in and the last row it took. The client loops: send back the cursor
   *       it was just handed, apply each page as it lands, and stop at the page
   *       that answers `hasMore: false`. Only that last cursor is worth storing
   *       for the next pull, and it decodes to the position minted on the first
   *       page of the loop.
   *
   *       The cursor time does not move inside a loop, so every page of it
   *       reads the same window: no row arrives twice and none is skipped. A
   *       row that changes between two pages is not chased into a later page —
   *       it leaves the window, and the next delta after the loop carries it.
   *       A paged snapshot answers `reset: true` on every one of its pages, and
   *       a paged delta stays `reset: false` throughout.
   *
   *       Tables arrive in dependency order across the loop, so a page that
   *       resumes inside one table carries the tables before it as empty
   *       arrays: they landed on an earlier page. The tables this endpoint does
   *       not fill yet — `users`, `groupMirrors`, `userYearQuotas`,
   *       `bankHolidays` and `vacations` — arrive as empty arrays throughout.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: cursor
   *         in: query
   *         required: false
   *         description: |
   *           The opaque cursor from a previous pull, sent back verbatim.
   *           Omitting it asks for a full snapshot. Never rejected: a cursor
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
   *                   description: |
   *                     Opaque position to send back on the next call, minted
   *                     when this pull started. While `hasMore` is true it also
   *                     carries where this page stopped, so the next call
   *                     continues the same loop rather than starting a pull
   *                 hasMore:
   *                   type: boolean
   *                   description: |
   *                     True when another page of this pull is waiting: call
   *                     again with `cursor` until a page answers false
   *                 reset:
   *                   type: boolean
   *                   description: |
   *                     True when the payload is a full snapshot rather than a
   *                     delta: no cursor, or one the server could not use
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
   *                         description: Set on a tombstone; null on a live row
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
   *                         description: Set on a tombstone; null on a live row
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
