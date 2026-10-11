import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetCalendars } from "../controllers/calendarSync/handleGetCalendars.js";
import { handleGetCalendar } from "../controllers/calendarSync/handleGetCalendar.js";
import { handlePostCalendar } from "../controllers/calendarSync/handlePostCalendar.js";
import { handleUpdateCalendar } from "../controllers/calendarSync/handleUpdateCalendar.js";
import { handleDeleteCalendar } from "../controllers/calendarSync/handleDeleteCalendar.js";
import { handleRegenerateToken } from "../controllers/calendarSync/handleRegenerateToken.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import {
  validateStartCalendarConnection,
  validateUpdateCalendarTarget,
} from "../services/calendarConnection/types.js";
import { handleGetConnections } from "../controllers/calendarConnection/handleGetConnections.js";
import { handlePostConnectionStart } from "../controllers/calendarConnection/handlePostConnectionStart.js";
import { handleGetConnectionCallback } from "../controllers/calendarConnection/handleGetConnectionCallback.js";
import { handleDeleteConnection } from "../controllers/calendarConnection/handleDeleteConnection.js";
import { handlePutTarget } from "../controllers/calendarConnection/handlePutTarget.js";
import { handleDeleteTarget } from "../controllers/calendarConnection/handleDeleteTarget.js";
import { handlePostTargetSync } from "../controllers/calendarConnection/handlePostTargetSync.js";

/** Mounted ahead of `authSession`; see the route's own block. */
export const calendarSyncCallbackRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/calendar-sync/connections/{provider}/callback:
   *   get:
   *     tags:
   *       - Calendar sync
   *     summary: Finish connecting a calendar account (provider redirect target)
   *     description: |
   *       Google or Microsoft sends the browser here after the consent screen.
   *       No session is read: the signed `state` minted by the start route is
   *       the only credential. It binds the user, the config, the time zone and
   *       the provider, and expires after ten minutes. When it verifies and its
   *       user still owns the `ME` config, the code is exchanged, the connection
   *       is created or revived (capability reset to `UNKNOWN`), the config is
   *       attached as a target and every target on the connection is marked due.
   *
   *       Always answers with a redirect to the web app:
   *       `{APP_URL}/calendar-sync/?connected={provider}&config={id}` on success,
   *       `{APP_URL}/calendar-sync/?error={code}&config={id}` on failure. `config`
   *       is omitted when the state could not be trusted or the config is gone.
   *       Error codes: `state_invalid`, `provider_off`, `consent_denied`,
   *       `provider_error`, `config_not_found`, `team_scope`, `target_exists`,
   *       `scope_denied`, `exchange_failed`, `server_error`. Tokens and the provider's own error
   *       text never appear in the redirect.
   *     operationId: handleGetConnectionCallback
   *     security: []
   *     parameters:
   *       - name: provider
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           enum: [google, microsoft]
   *       - name: state
   *         in: query
   *         required: true
   *         schema:
   *           type: string
   *         description: The signed state from the start route
   *       - name: code
   *         in: query
   *         required: false
   *         schema:
   *           type: string
   *         description: Authorization code, present when the user consented
   *       - name: error
   *         in: query
   *         required: false
   *         schema:
   *           type: string
   *         description: Provider error, e.g. `access_denied` when the user declined
   *     responses:
   *       '302':
   *         description: Redirect to the web app's calendar-sync page with `connected` or `error`
   *         headers:
   *           Location:
   *             schema:
   *               type: string
   *       '404':
   *         description: |
   *           Unknown provider, or direct sync is switched off for every provider.
   *           `errors[].context.code` is `CALENDAR_SYNC_PROVIDER_OFF`.
   */
  app.get("/connections/:provider/callback", tryCatch(handleGetConnectionCallback));

  return app;
};

export const calendarSyncRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/calendar-sync/connections:
   *   get:
   *     tags:
   *       - Calendar sync
   *     summary: List the caller's calendar connections and the providers that can be connected
   *     description: |
   *       One entry per connected provider. Tokens are never returned.
   *       `providers` says which provider switches are on; the web hides the
   *       connect button of a provider that is off.
   *     operationId: handleGetConnections
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: The caller's connections
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [providers, connections]
   *               properties:
   *                 providers:
   *                   type: object
   *                   required: [google, microsoft]
   *                   properties:
   *                     google:
   *                       type: boolean
   *                     microsoft:
   *                       type: boolean
   *                 connections:
   *                   type: array
   *                   items:
   *                     $ref: '#/components/schemas/CalendarConnection'
   *       '401':
   *         description: Unauthorized
   * components:
   *   schemas:
   *     CalendarConnection:
   *       type: object
   *       required: [provider, status, capability, createdAt]
   *       properties:
   *         provider:
   *           type: string
   *           enum: [GOOGLE, MICROSOFT]
   *         status:
   *           type: string
   *           enum: [ACTIVE, NEEDS_RECONNECT]
   *         capability:
   *           type: string
   *           enum: [UNKNOWN, STATUS, PLAIN]
   *           description: Whether the account accepts Google's status event types
   *         createdAt:
   *           type: string
   *           format: date-time
   *     CalendarSyncConfig:
   *       type: object
   *       required: [id, name, scope, distinguishMine, teamIds, types, feedUrl, tokenMasked, lastFetchedAt, target, createdAt, updatedAt]
   *       properties:
   *         id:
   *           type: string
   *           format: uuid
   *         name:
   *           type: string
   *         scope:
   *           type: string
   *           enum: [ME, TEAM]
   *         distinguishMine:
   *           type: boolean
   *         teamIds:
   *           type: array
   *           items:
   *             type: string
   *             format: uuid
   *         types:
   *           type: array
   *           items:
   *             type: object
   *             properties:
   *               type:
   *                 type: string
   *               label:
   *                 type: string
   *               color:
   *                 type: string
   *               mineColor:
   *                 type: string
   *                 nullable: true
   *         feedUrl:
   *           type: string
   *           description: The `.ics` subscription URL, its token masked in lists
   *         tokenMasked:
   *           type: boolean
   *         lastFetchedAt:
   *           type: string
   *           format: date-time
   *           nullable: true
   *         target:
   *           allOf:
   *             - $ref: '#/components/schemas/CalendarTarget'
   *           nullable: true
   *         createdAt:
   *           type: string
   *           format: date-time
   *         updatedAt:
   *           type: string
   *           format: date-time
   *     CalendarTarget:
   *       type: object
   *       description: Direct sync of a `ME` config into a connected account; `null` when off.
   *       required: [provider, status, capability, timeZone, lastSyncedAt, lastError, syncing]
   *       properties:
   *         provider:
   *           type: string
   *           enum: [GOOGLE, MICROSOFT]
   *         status:
   *           type: string
   *           enum: [ACTIVE, NEEDS_RECONNECT, PAUSED]
   *           description: |
   *             `NEEDS_RECONNECT` once the grant was revoked or lapsed; `PAUSED`
   *             while no organization covering the owner is on a paid plan.
   *         capability:
   *           type: string
   *           enum: [UNKNOWN, STATUS, PLAIN]
   *         timeZone:
   *           type: string
   *           description: IANA time zone timed events are written in
   *         lastSyncedAt:
   *           type: string
   *           format: date-time
   *           nullable: true
   *         lastError:
   *           type: string
   *           nullable: true
   *         syncing:
   *           type: boolean
   *           description: A sync is due or running
   */
  app.get("/connections", tryCatch(handleGetConnections));

  /**
   * @openapi
   * /api/calendar-sync/connections/{provider}/start:
   *   post:
   *     tags:
   *       - Calendar sync
   *     summary: Start connecting a calendar account for one ME config
   *     description: |
   *       Returns the provider's consent URL. Its `state` is signed with the
   *       better-auth secret and binds the caller, the config, the time zone and
   *       the provider for ten minutes. Google asks for
   *       `calendar.events.owned` alone with offline access; Microsoft asks for
   *       `Calendars.ReadWrite offline_access` on the `common` authority. Google
   *       forces the consent screen, because it returns a refresh token only on
   *       consent; Microsoft lets the user pick the account and shows consent
   *       only for a scope not yet granted, so a tenant whose admin consented
   *       for everyone connects without it. Either way each connection redeems
   *       its own code and keeps its own refresh token, separate from any
   *       sign-in link.
   *     operationId: handlePostConnectionStart
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: provider
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           enum: [google, microsoft]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [configId, timeZone]
   *             properties:
   *               configId:
   *                 type: string
   *                 format: uuid
   *               timeZone:
   *                 type: string
   *                 description: IANA zone from the browser, e.g. `Europe/Prague`; offsets are refused
   *     responses:
   *       '200':
   *         description: Where to send the browser
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [url]
   *               properties:
   *                 url:
   *                   type: string
   *                   format: uri
   *       '400':
   *         description: |
   *           The config is `TEAM`-scoped; only a calendar of the caller's own
   *           records can sync. `errors[].context.code` is `CALENDAR_SYNC_TEAM_SCOPE`.
   *       '401':
   *         description: Unauthorized
   *       '402':
   *         description: |
   *           No organization covering the caller's groups is on a paid plan.
   *           `errors[].context` carries
   *           `{ reason: "PLAN_LIMIT", code: "CALENDAR_SYNC_PLAN_REQUIRED" }`.
   *       '404':
   *         description: |
   *           Unknown provider, provider switched off, or calendar not found. For an
   *           unknown or switched-off provider `errors[].context.code` is
   *           `CALENDAR_SYNC_PROVIDER_OFF`.
   *       '409':
   *         description: |
   *           The config already syncs through the other provider; one target per
   *           config. `errors[].context.code` is `CALENDAR_SYNC_TARGET_EXISTS`.
   *       '422':
   *         description: Validation error (bad config id or a time zone that is not IANA)
   */
  app.post(
    "/connections/:provider/start",
    bodyValidationMiddleware(validateStartCalendarConnection),
    tryCatch(handlePostConnectionStart)
  );

  /**
   * @openapi
   * /api/calendar-sync/connections/{provider}:
   *   delete:
   *     tags:
   *       - Calendar sync
   *     summary: Disconnect a calendar account
   *     description: |
   *       Removes every event the app wrote on each target of the connection and
   *       turns those targets off, revokes the refresh token at the provider
   *       where an endpoint exists (Google; Microsoft has none), and deletes the
   *       connection. A revoke that fails is logged and does not fail the
   *       request. Sign-in links to the same account are never touched.
   *     operationId: handleDeleteConnection
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: provider
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           enum: [google, microsoft]
   *     responses:
   *       '200':
   *         description: Disconnected
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *       '401':
   *         description: Unauthorized
   *       '404':
   *         description: |
   *           Unknown provider, or no connection to it. For an unknown provider
   *           `errors[].context.code` is `CALENDAR_SYNC_PROVIDER_OFF`.
   */
  app.delete("/connections/:provider", tryCatch(handleDeleteConnection));

  /**
   * @openapi
   * /api/calendar-sync:
   *   get:
   *     tags:
   *       - Calendar sync
   *     summary: List the caller's calendar-sync feeds (feed tokens masked)
   *     description: |
   *       Each config carries `target`, its direct sync into a connected
   *       account (see `CalendarTarget`), or `null` when direct sync is off.
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: Array of calendar-sync configs, each with `target`
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/CalendarSyncConfig'
   */
  app.get("/", tryCatch(handleGetCalendars));

  /**
   * @openapi
   * /api/calendar-sync:
   *   post:
   *     tags:
   *       - Calendar sync
   *     summary: Create a calendar-sync feed
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - name
   *               - types
   *             properties:
   *               name:
   *                 type: string
   *                 minLength: 1
   *                 maxLength: 120
   *               scope:
   *                 type: string
   *                 enum: [ME, TEAM]
   *                 default: ME
   *               distinguishMine:
   *                 type: boolean
   *                 default: false
   *               teamIds:
   *                 type: array
   *                 items:
   *                   type: string
   *                   format: uuid
   *               types:
   *                 type: array
   *                 minItems: 1
   *                 items:
   *                   type: object
   *                   required:
   *                     - type
   *                     - color
   *                   properties:
   *                     type:
   *                       type: string
   *                     color:
   *                       type: string
   *                       description: Swatch palette key (e.g. "violet")
   *                     mineColor:
   *                       type: string
   *     responses:
   *       '201':
   *         description: The created config, including its full feed URL
   *       '403':
   *         description: A requested team is not one the caller belongs to
   */
  app.post("/", tryCatch(handlePostCalendar));

  /**
   * @openapi
   * /api/calendar-sync/{id}:
   *   get:
   *     tags:
   *       - Calendar sync
   *     summary: Get a single calendar-sync feed with its full feed URL
   *     description: |
   *       Carries `target`, the config's direct sync into a connected account
   *       (see `CalendarTarget`), or `null` when direct sync is off.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     responses:
   *       '200':
   *         description: The config
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/CalendarSyncConfig'
   *       '404':
   *         description: Calendar not found
   */
  app.get("/:id", tryCatch(handleGetCalendar));

  /**
   * @openapi
   * /api/calendar-sync/{id}:
   *   put:
   *     tags:
   *       - Calendar sync
   *     summary: Replace a calendar-sync feed's settings, teams and types
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
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
   *               - name
   *               - types
   *             properties:
   *               name:
   *                 type: string
   *                 minLength: 1
   *                 maxLength: 120
   *               scope:
   *                 type: string
   *                 enum: [ME, TEAM]
   *                 default: ME
   *               distinguishMine:
   *                 type: boolean
   *                 default: false
   *               teamIds:
   *                 type: array
   *                 items:
   *                   type: string
   *                   format: uuid
   *               types:
   *                 type: array
   *                 minItems: 1
   *                 items:
   *                   type: object
   *                   required:
   *                     - type
   *                     - color
   *                   properties:
   *                     type:
   *                       type: string
   *                     color:
   *                       type: string
   *                       description: Swatch palette key (e.g. "violet")
   *                     mineColor:
   *                       type: string
   *     responses:
   *       '200':
   *         description: The updated config
   *       '400':
   *         description: |
   *           Invalid calendar id, or `scope: TEAM` on a config that syncs to a
   *           connected account; turn its direct sync off first.
   *           `errors[].context.code` is `CALENDAR_SYNC_TEAM_SCOPE`.
   *       '404':
   *         description: Calendar not found
   */
  app.put("/:id", tryCatch(handleUpdateCalendar));

  /**
   * @openapi
   * /api/calendar-sync/{id}:
   *   delete:
   *     tags:
   *       - Calendar sync
   *     summary: Delete a calendar-sync feed
   *     description: A config that syncs to a connected account first removes the events it wrote there.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     responses:
   *       '200':
   *         description: Calendar deleted
   *       '404':
   *         description: Calendar not found
   */
  app.delete("/:id", tryCatch(handleDeleteCalendar));

  /**
   * @openapi
   * /api/calendar-sync/{id}/regenerate-token:
   *   post:
   *     tags:
   *       - Calendar sync
   *     summary: Rotate the feed token, revoking the previous link
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     responses:
   *       '200':
   *         description: The config with a new feed URL
   *       '404':
   *         description: Calendar not found
   */
  app.post("/:id/regenerate-token", tryCatch(handleRegenerateToken));

  /**
   * @openapi
   * /api/calendar-sync/{id}/target:
   *   put:
   *     tags:
   *       - Calendar sync
   *     summary: Change the time zone a direct-sync target writes in
   *     description: Stores the new zone and marks the target due, so its events are rewritten.
   *     operationId: handlePutTarget
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
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
   *             required: [timeZone]
   *             properties:
   *               timeZone:
   *                 type: string
   *                 description: IANA zone, e.g. `Europe/Prague`; offsets are refused
   *     responses:
   *       '200':
   *         description: The config, with its `target`
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/CalendarSyncConfig'
   *       '400':
   *         description: Invalid calendar id
   *       '401':
   *         description: Unauthorized
   *       '404':
   *         description: Calendar not found, or direct sync is off for it
   *       '422':
   *         description: The time zone is not an IANA name
   *   delete:
   *     tags:
   *       - Calendar sync
   *     summary: Turn direct sync off for one calendar
   *     description: |
   *       Removes every event this target wrote and clears the target. The
   *       connection and the `.ics` feed stay.
   *     operationId: handleDeleteTarget
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     responses:
   *       '200':
   *         description: Direct sync turned off
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *       '400':
   *         description: Invalid calendar id
   *       '401':
   *         description: Unauthorized
   *       '404':
   *         description: Calendar not found, or direct sync is already off
   */
  app.put(
    "/:id/target",
    bodyValidationMiddleware(validateUpdateCalendarTarget),
    tryCatch(handlePutTarget)
  );
  app.delete("/:id/target", tryCatch(handleDeleteTarget));

  /**
   * @openapi
   * /api/calendar-sync/{id}/target/sync:
   *   post:
   *     tags:
   *       - Calendar sync
   *     summary: Sync a direct-sync target now
   *     description: Marks the target due and queues it; answers before the sync runs.
   *     operationId: handlePostTargetSync
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     responses:
   *       '202':
   *         description: Queued; the config with its `target`, `syncing` true
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/CalendarSyncConfig'
   *       '400':
   *         description: Invalid calendar id
   *       '401':
   *         description: Unauthorized
   *       '402':
   *         description: |
   *           No paid plan covers the caller. `errors[].context` carries
   *           `{ reason: "PLAN_LIMIT", code: "CALENDAR_SYNC_PLAN_REQUIRED" }`.
   *       '404':
   *         description: Calendar not found, or direct sync is off for it
   *       '409':
   *         description: |
   *           The connection needs a new consent round.
   *           `errors[].context.code` is `CALENDAR_SYNC_NEEDS_RECONNECT`.
   */
  app.post("/:id/target/sync", tryCatch(handlePostTargetSync));

  return app;
};
