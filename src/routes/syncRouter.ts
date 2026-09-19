import { Router } from "express";
import compression from "compression";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetSyncPull } from "../controllers/sync/handleGetSyncPull.js";

export const syncRouter = (): Router => {
  const app = Router();

  // `threshold: 0` rather than the default 1 KB: the client's transport
  // contract should not depend on how big a given page happens to be.
  app.use(compression({ threshold: 0 }));

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
   *       Scope is membership-only, exactly the web dashboard and calendar,
   *       and it is read from the caller's live `group_users` rows. A group
   *       they hold no such row in is left out whatever else they are there,
   *       an org admin of the owning organization or the group's own manager.
   *       A group where their row carries view access or admin access, or
   *       where they are the manager, returns its whole member list; a group
   *       where they are a plain member returns only their own membership row.
   *
   *       `vacations` splits the same way: a group seen in full carries every
   *       member's bookings, a self-scoped group only the caller's. On top of
   *       that the caller's own bookings arrive from every group they hold
   *       them in, including one they have left, because the personal calendar
   *       still shows them. `groups` then also carries the row of any group
   *       that owns a returned booking, so the client can label it, and a
   *       group row arriving without a membership row is how the client
   *       recognises a former group. Nothing else of a former group ships: no
   *       other member's bookings, no membership row, no quota row. The one
   *       exception is `users`, which still names whoever approved, rejected,
   *       booked or cancelled a returned booking, because the client cannot
   *       render the row without them.
   *
   *       A group seen in full also carries the mirrors pointing into it:
   *       `groupMirrors` holds every live mirror whose target is that group,
   *       carrying the target group's `organizationId`. With each one come the
   *       bookings it projects — the mirrored person's rows in the source
   *       group, on the same history window and the same delta rules as any
   *       other booking. Those rows stay rows of the source group, so they
   *       carry that group's id and organization, not the target's, and the
   *       source group and the mirrored person ship in `groups` and `users` so
   *       the client can label them. A mirror is only followed while its owner
   *       still belongs to the target group: once they leave, neither the
   *       mirror row nor the bookings it projected arrive. A mirror into a
   *       self-scoped group brings neither, because the mirror is a row of the
   *       target group the caller does not see in full.
   *
   *       A mirror appearing in or leaving a group the caller belongs to is
   *       a sync reset trigger, so a removed mirror is answered by a snapshot
   *       that no longer carries it rather than by a tombstone, and the client
   *       drops it in the sweep that follows a reset. The same holds when the
   *       mirror's owner leaves or rejoins the target group.
   *
   *       Bookings are raw rows, `note` and `rejectionReason` included, with
   *       no per-row verdict — whether the caller may approve or cancel one
   *       stays on the action endpoints.
   *
   *       `userYearQuotas` splits the same way but does not reach past the
   *       caller's current groups: every member's rows in a group seen in
   *       full, the caller's own rows in their other groups, and nothing from
   *       a group they have left.
   *
   *       `users` carries `id`, `name`, `image` and `updatedAt` and nothing
   *       else — no email, no account state. It holds the members and the
   *       manager of every group seen in full, the caller, and every actor
   *       named on a booking this pull covers: who created it, who approved
   *       it, who rejected it and who cancelled it. Those actors arrive
   *       whatever their own `updatedAt` says, and on a paged pull they arrive
   *       before the bookings that name them, so no returned booking ever
   *       names somebody the client cannot resolve. The people on the
   *       membership rows a pull carries arrive the same way, so a member
   *       added to a group seen in full is never nameless. Everybody else in
   *       the set arrives only when their own row changed since the cursor,
   *       which is how an approver renamed long after a booking settled
   *       reaches the client.
   *
   *       `users` and `userYearQuotas` carry no `deletedAt` and so ship no
   *       tombstones. Somebody who leaves a group stays in `users` as a stale
   *       row until a sync reset drops it, and a quota row is rewritten rather
   *       than deleted.
   *
   *       `bankHolidays` carries the public holidays of the holiday country of
   *       every group the caller belongs to, so the phone's calendar marks them
   *       without a call of its own. The span is the previous, current and next
   *       calendar year of the position this pull was minted with, read in UTC,
   *       and only rows with no region ship: a regional variant is not what a
   *       group-wide calendar marks. A country held only by a group the caller
   *       is not a member of is absent, and none of a group they have left, a
   *       soft-deleted one a delta still tombstones, or the source group of a
   *       mirror adds one. Before reading, the server computes and stores any
   *       of those country-and-year pairs it has never seen, so a first pull
   *       for a new country is never empty; those rows are new, so they arrive
   *       on the pull that created them. They are stamped after that pull's
   *       position was minted, so the next delta carries them once more, like
   *       any row the overlap repeats. The rows are
   *       unpartitioned reference data: no `organizationId`, no `deletedAt`
   *       and so no tombstones, and a holiday that leaves the window drops off
   *       at the next sync reset like any other dated row.
   *
   *       The two dated tables reach back to 1 January of the previous year on
   *       the server clock, read in UTC: `vacations` by `requestedDay`,
   *       `userYearQuotas` by `relatedYear`. A row dated before that boundary
   *       is absent however recently it changed. The boundary comes from the
   *       position the pull was minted with, so it holds still across every
   *       page of one loop.
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
   *       minted with, ordered by `updatedAt` then `id`. `bankHolidays` is the
   *       one table bounded from below alone, so the rows its own fill just
   *       wrote are not held back. `organizations` names the organization of
   *       every group in the delta and only those: an organization renamed on
   *       its own carries no group with it, so the new name reaches the client
   *       on the next pull that does carry one of its groups.
   *       The 60 second overlap covers the clock difference between the
   *       database, which stamps inserts, and the server instance that stamps
   *       an update, so the same row may arrive on two consecutive pulls; a
   *       client applies rows as upserts and the second delivery changes
   *       nothing.
   *
   *       A soft-deleted row arrives in a delta as a tombstone: the whole row
   *       with `deletedAt` set, so the client can drop its copy. In a group
   *       the caller sees in full that is the membership of anybody else who
   *       left it, and beyond their own groups it is the row of a group they
   *       have left and still hold bookings in, whose deletion triggers
   *       nothing because they no longer belong to it. Their own removal, a
   *       group of theirs being deleted and a mirror added to or removed from
   *       one are reset triggers instead, so the snapshot that answers them
   *       stops carrying those rows rather than tombstoning them. A snapshot
   *       holds live membership and mirror rows only, for the same reason —
   *       the client sweeps whatever the snapshot did not re-send.
   *
   *       A cancelled booking arrives the same way, in full with `deletedAt`
   *       and `deletedByUserId` set, but the client keeps it rather than
   *       dropping it: the web calendar shows cancelled bookings as history.
   *       For the same reason a snapshot carries them too, so a sync reset
   *       does not sweep away history the phone is meant to hold.
   *
   *       A pull answers a sync reset — `reset` is `true` and the payload is a
   *       full snapshot rather than a delta — when the request carries no
   *       cursor, a cursor the server cannot decode, a cursor minted by another
   *       cursor version, a cursor whose time is more than 30 days old, a
   *       cursor whose time is more than 60 seconds ahead of the server clock,
   *       a fresh pull whose cursor was minted in an earlier calendar year
   *       (the history window has moved, and only a snapshot lets the client
   *       sweep the rows that fell out of it; a cursor resuming a paged loop
   *       is not checked for this and finishes on the window it started
   *       with), a cursor whose paging state the
   *       server cannot resume, or anything else it cannot read as one
   *       cursor, such as the parameter repeated. A
   *       cursor is never rejected with an error, and an unusable one mid-loop
   *       restarts the loop as a fresh snapshot.
   *
   *       A pull also answers a sync reset when what the caller may see moved
   *       under the cursor, which no set of changed rows can express. The
   *       triggers are a row changed later than the cursor time minus 60
   *       seconds and no later than the position this pull was minted with —
   *       a soft delete counts, because it stamps `updatedAt` like any other
   *       write — in one of four places:
   *
   *       - a `groupUsers` row of the caller, in any group: joining, gaining
   *         or losing a flag, or being removed;
   *       - a `groupMirrors` row whose target is a group the caller belongs
   *         to, added or removed;
   *       - a `groupUsers` row of a mirror's owner in the target group of that
   *         mirror, when the caller belongs to it: a mirror shows only while
   *         its owner is a member, so the owner joining or leaving changes
   *         what the caller sees without touching the mirror row;
   *       - a `groups` row of a group the caller belongs to: a manager
   *         transfer, a rename, a holiday country change or a soft delete.
   *
   *       Anything else stays a delta carrying only the rows that changed:
   *       another member's booking, a quota edit, a membership change in a
   *       group the caller does not belong to, a mirror into one. The triggers
   *       are read once per pull, for a fresh delta only: a pull resuming a
   *       paged loop stays in the loop it belongs to, whichever kind that is.
   *
   *       A pull is paged at a fixed 1000 rows across all tables, and there is
   *       no `limit` parameter. When more rows are waiting, `hasMore` is `true`
   *       and the same opaque `cursor` also carries the table the page stopped
   *       in, the last row it took and which kind of loop it belongs to, so
   *       `reset` cannot flip halfway through. The client loops: send back the
   *       cursor it was handed, apply each page as it lands, and stop at the page
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
   *       arrays: they landed on an earlier page.
   *
   *       A pull is answered encoded whatever the size of the page, and the
   *       response names the coding in `Content-Encoding`. It is negotiated
   *       from the request header with Brotli preferred over gzip, so a client
   *       sending `Accept-Encoding: gzip` is answered `gzip` and one that also
   *       offers `br` is answered `br`; a request advertising no coding at all
   *       gets plain JSON. This is
   *       the only compressed route in the API. The payload is the same
   *       either way, and every response carries
   *       `Cache-Control: no-store`: it is one caller's rows and no cache may
   *       hold it.
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
   *         headers:
   *           Cache-Control:
   *             schema:
   *               type: string
   *             description: Always `no-store`
   *           Content-Encoding:
   *             schema:
   *               type: string
   *             description: |
   *               `br` when the request accepts Brotli, `gzip` when it accepts
   *               gzip and not Brotli, `deflate` when that is all it offers;
   *               absent when it advertised none
   *           Vary:
   *             schema:
   *               type: string
   *             description: Includes `Accept-Encoding`
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
   *                     delta: no cursor, one the server could not use, or a
   *                     change since the cursor to what the caller may see
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
   *                   description: |
   *                     The people named on this page's rows, four columns
   *                     only. Never tombstoned
   *                   items:
   *                     type: object
   *                     properties:
   *                       id:
   *                         type: string
   *                       name:
   *                         type: string
   *                       image:
   *                         type: string
   *                         nullable: true
   *                       updatedAt:
   *                         type: string
   *                         format: date-time
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
   *                   description: |
   *                     Mirrors pointing into a group the caller sees in full,
   *                     each carrying the target group's organization
   *                   items:
   *                     type: object
   *                     properties:
   *                       id:
   *                         type: string
   *                       userId:
   *                         type: string
   *                         description: The person whose bookings the mirror projects
   *                       sourceGroupId:
   *                         type: string
   *                         description: The group the projected bookings belong to
   *                       targetGroupId:
   *                         type: string
   *                         description: The group they are shown in
   *                       organizationId:
   *                         type: string
   *                         description: The target group's organization
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
   *                 userYearQuotas:
   *                   type: array
   *                   description: |
   *                     Allowances by year, from the previous year onwards.
   *                     Never tombstoned
   *                   items:
   *                     type: object
   *                     properties:
   *                       id:
   *                         type: string
   *                       userId:
   *                         type: string
   *                       groupId:
   *                         type: string
   *                       organizationId:
   *                         type: string
   *                       relatedYear:
   *                         type: string
   *                         description: Four digits, `YYYY`
   *                       vacationDays:
   *                         type: integer
   *                       homeOfficeDays:
   *                         type: integer
   *                       sickDays:
   *                         type: integer
   *                       carriedOverDays:
   *                         type: integer
   *                       createdAt:
   *                         type: string
   *                         format: date-time
   *                       updatedAt:
   *                         type: string
   *                         format: date-time
   *                 bankHolidays:
   *                   type: array
   *                   description: |
   *                     Public holidays of the caller's groups' countries,
   *                     region-less, from 1 January of the previous year to 31
   *                     December of the next. Unpartitioned, never tombstoned
   *                   items:
   *                     type: object
   *                     properties:
   *                       id:
   *                         type: string
   *                       date:
   *                         type: string
   *                         format: date
   *                       name:
   *                         type: string
   *                         description: In the country's own language, as the dataset names it
   *                       country:
   *                         type: string
   *                         description: Alpha-2 country code
   *                       region:
   *                         type: string
   *                         nullable: true
   *                         description: Always null here; a regional holiday does not ship
   *                       createdAt:
   *                         type: string
   *                         format: date-time
   *                       updatedAt:
   *                         type: string
   *                         format: date-time
   *                 vacations:
   *                   type: array
   *                   description: |
   *                     Bookings requested on or after 1 January of the
   *                     previous year, one row per day
   *                   items:
   *                     type: object
   *                     properties:
   *                       id:
   *                         type: string
   *                       userId:
   *                         type: string
   *                       groupId:
   *                         type: string
   *                       organizationId:
   *                         type: string
   *                       requestId:
   *                         type: string
   *                         description: Shared by every day row of one submission
   *                       requestedDay:
   *                         type: string
   *                         format: date
   *                       startTime:
   *                         type: string
   *                         nullable: true
   *                       endTime:
   *                         type: string
   *                         nullable: true
   *                       vacationType:
   *                         type: string
   *                         enum:
   *                           - VACATION
   *                           - HOME_OFFICE
   *                           - SICK
   *                           - BANK_HOLIDAY
   *                           - NON_PAID_LEAVE
   *                           - PAID_TIME_OFF
   *                           - SICK_DAY
   *                           - STUDY_LEAVE
   *                           - OTHER
   *                       halfDay:
   *                         type: boolean
   *                         description: Authoritative for quota accounting, unlike the times
   *                       approvedAt:
   *                         type: string
   *                         format: date-time
   *                         nullable: true
   *                       approvedBy:
   *                         type: string
   *                         nullable: true
   *                       rejectedAt:
   *                         type: string
   *                         format: date-time
   *                         nullable: true
   *                       rejectedBy:
   *                         type: string
   *                         nullable: true
   *                       rejectionReason:
   *                         type: string
   *                         nullable: true
   *                       note:
   *                         type: string
   *                         nullable: true
   *                       createdByUserId:
   *                         type: string
   *                         nullable: true
   *                         description: Differs from userId when somebody booked on the member's behalf
   *                       deletedAt:
   *                         type: string
   *                         format: date-time
   *                         nullable: true
   *                         description: Set on a cancelled booking, which the client keeps as history
   *                       deletedByUserId:
   *                         type: string
   *                         nullable: true
   *                       createdAt:
   *                         type: string
   *                         format: date-time
   *                       updatedAt:
   *                         type: string
   *                         format: date-time
   *       '401':
   *         description: Unauthorized - missing or invalid authentication
   */
  app.get("/pull", tryCatch(handleGetSyncPull));

  return app;
};
