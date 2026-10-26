import express from "express";
import { serverCors } from "./middleware/cors.js";
import { helmetHeaders } from "./middleware/headers.js";
import {
  apiFailureLimiter,
  apiLimiter,
  calendarFeedLimiter,
  CREDENTIAL_GUESSING_PATHS,
  credentialsLimiter,
  floodLimiter,
  otpSendLimiter,
  passwordResetLimiter,
  signedWebhookLimiter,
} from "./middleware/limiter.js";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./utils/auth.js";
import { config } from "./config.js";
import { errorMiddleware } from "./middleware/errorMiddleware.js";
import { vacationRouter } from "./routes/vacationRouter.js";
import { authSession } from "./middleware/authSession.js";
import { groupRouter } from "./routes/groupRouter.js";
import { groupUsersRouter } from "./routes/groupUsersRouter.js";
import { quotasRouter } from "./routes/quotasRouter.js";
import { authExtRouter } from "./routes/authExtRouter.js";
import { usersRouter } from "./routes/usersRouter.js";
import { bankHolidayRouter } from "./routes/bankHolidayRouter.js";
import { notificationRouter } from "./routes/notificationRouter.js";
import { calendarSyncCallbackRouter, calendarSyncRouter } from "./routes/calendarSyncRouter.js";
import { reportRouter } from "./routes/reportRouter.js";
import { syncRouter } from "./routes/syncRouter.js";
import { birthdayRouter } from "./routes/birthdayRouter.js";
import { groupEventRouter } from "./routes/groupEventRouter.js";
import { tryCatch } from "./middleware/tryCatch.js";
import { handleGetCalendarFeed } from "./controllers/calendarSync/handleGetCalendarFeed.js";
import { devRouter } from "./routes/devRouter.js";
import { requestContext } from "./middleware/requestContext.js";
import { billingRouter } from "./routes/billingRouter.js";
import { organizationRouter } from "./routes/organizationRouter.js";
import { employmentRouter } from "./routes/employmentRouter.js";
import { directoryRouter } from "./routes/directoryRouter.js";
import { directoryListRouter } from "./routes/directoryListRouter.js";
import { attendanceRouter } from "./routes/attendanceRouter.js";
import { handlePaddleWebhook } from "./controllers/billing/handlePaddleWebhook.js";
import { supportRouter } from "./routes/supportRouter.js";
import { attachmentRouter } from "./routes/attachmentRouter.js";
import { localAttachmentRouter } from "./routes/localAttachmentRouter.js";
import { photoCallbackRouter } from "./routes/photoCallbackRouter.js";
import { attachmentCallbackRouter } from "./routes/attachmentCallbackRouter.js";
import { isDiskAttachmentStore } from "./services/attachment/attachmentStore.js";
import { isDiskOrganizationDataStore } from "./services/organizationData/organizationDataStore.js";
import { localOrganizationDataRouter, personExportRouter } from "./routes/personExportRouter.js";

export const createServer = () => {
  const app = express();
  // `requestContext` sits ahead of every route, including better-auth's catch-all.
  app
    .set("trust proxy", 1)
    .use(serverCors)
    .use(requestContext)
    .use(helmetHeaders)
    .use(floodLimiter);

  // Only the endpoints where a wrong guess is the point (see the list's own
  // doc for why two-factor is covered whole). Registered before better-auth's
  // catch-all so it cannot swallow them, and before any body parser so
  // better-auth still receives its raw body.
  app.use(CREDENTIAL_GUESSING_PATHS, credentialsLimiter);

  // Not `credentialsLimiter`: it counts only failures, and asking for a reset
  // always succeeds by design. The cost here is the email it sends.
  app.use("/api/auth/request-password-reset", passwordResetLimiter);

  // Same shape as password reset: always 200, the cost is the email.
  app.use("/api/auth/two-factor/send-otp", otpSendLimiter);

  // Project-specific auth orchestration endpoints. These must be registered
  // BEFORE better-auth's catch-all `.all()` so the catch-all does not swallow
  // them. They need JSON body parsing, scoped tightly so the raw body that
  // better-auth itself needs is left untouched on its own paths.
  app.use("/api/auth/sign-up-with-team", express.json());
  app.use("/api/auth/invite", express.json());
  app.use("/api/auth", authExtRouter());

  // Paddle webhook. Registered BEFORE the global `express.json()` so it gets
  // the raw body (HMAC verification needs the exact bytes), and before the
  // `/api` session block so Paddle's cookie-less calls are not 401'd. It
  // authenticates by `Paddle-Signature` alone.
  app.post(
    "/api/webhooks/paddle",
    express.raw({ type: "application/json" }),
    signedWebhookLimiter,
    tryCatch(handlePaddleWebhook)
  );

  // The attachment processor's callback: same shape as the Paddle webhook,
  // signed with its own secret. Without one the route does not exist.
  if (config.attachments.callbackSecret) {
    app.use("/api/attachments/processed", attachmentCallbackRouter());
    app.use("/api/directory/photos/processed", photoCallbackRouter());
  }

  app.all("/api/auth/{*any}", toNodeHandler(auth)).use(express.json());

  // Local seeding/impersonation routes. `config.dev` is undefined unless the
  // environment explicitly opts in on a local database, so in every deployed
  // environment this branch never runs and the routes simply do not exist.
  if (config.dev) {
    app.use("/api/dev", devRouter());
  }

  // The calendar provider's redirect after consent. Ahead of `authSession`: the
  // browser arrives from Google or Microsoft and the signed state is the only
  // credential. Without a provider switched on the route does not exist.
  if (config.calendarSync) {
    app.use("/api/calendar-sync", calendarSyncCallbackRouter());
  }

  // The disk store's upload and download routes stand in for S3's presigned
  // URLs, so like those they are authorized by signature, not session. With a
  // bucket configured they do not exist.
  if (isDiskAttachmentStore) {
    app.use("/api/attachments/local", localAttachmentRouter());
  }
  if (isDiskOrganizationDataStore) {
    app.use("/api/organization-data/local", localOrganizationDataRouter());
  }

  // Everything below is the authenticated API; `/api/auth` and `/api/dev` are
  // already handled above, so this never double-counts them. The order is the
  // point: a cheap per-IP bound on rejected requests, then session validation,
  // then the per-user budget — which must key on a validated user id, because a
  // caller can invent a session cookie to hand itself an unused bucket.
  app.use("/api", apiFailureLimiter, authSession, apiLimiter);

  app.use("/api/vacation", vacationRouter());
  app.use("/api/group", groupRouter());
  app.use("/api/group-user", groupUsersRouter());
  app.use("/api/quotas", quotasRouter());
  app.use("/api/users", usersRouter());
  app.use("/api/bank-holidays", bankHolidayRouter());
  app.use("/api/notifications", notificationRouter());
  app.use("/api/calendar-sync", calendarSyncRouter());
  app.use("/api/reports", reportRouter());
  app.use("/api/billing", billingRouter());
  app.use("/api/organization", organizationRouter());
  app.use("/api/employment", employmentRouter());
  app.use("/api/directory", directoryRouter());
  app.use("/api/directory", directoryListRouter());
  app.use("/api/attendance", attendanceRouter());
  app.use("/api/attachments", attachmentRouter());
  app.use("/api/person-exports", personExportRouter());
  app.use("/api/sync", syncRouter());
  app.use("/api/birthdays", birthdayRouter());
  app.use("/api/group-events", groupEventRouter());

  // Platform-support read surface. `config.support` is undefined unless the
  // deploy explicitly carries an allowlist, so for everyone else these routes
  // simply do not exist.
  if (config.support) {
    app.use("/api/support", supportRouter());
  }

  /**
   * @openapi
   * /calendars/{token}.ics:
   *   get:
   *     tags:
   *       - Calendar sync
   *     summary: A calendar sync config's iCalendar feed
   *     description: |
   *       Deliberately outside `authSession`: calendar clients cannot send session
   *       cookies, so the token in the URL is the only credential and anyone holding
   *       the URL can read the feed. Carries the config's approved time off in its window
   *       (the last 12 months and everything ahead), plus group events and birthdays
   *       when switched on.
   *
   *       A time-off event's SUMMARY is `<name> — <type label>` and its CATEGORIES the
   *       label, in the owner's app language. The owner's own events carry their note
   *       as DESCRIPTION. On a `TEAM` feed every other person's events get the teammate
   *       view, whoever owns the feed: no DESCRIPTION, and Sick labelled Away (`Pryč`).
   *       The config's `SICK` type decides whether those Away events appear.
   *     operationId: handleGetCalendarFeed
   *     security: []
   *     parameters:
   *       - in: path
   *         name: token
   *         required: true
   *         schema:
   *           type: string
   *           pattern: '^flx_live_[a-f0-9]{40}$'
   *     responses:
   *       '200':
   *         description: The feed
   *         content:
   *           text/calendar:
   *             schema:
   *               type: string
   *       '404':
   *         description: Malformed token, or no config holds it
   *       '429':
   *         description: Too many fetches for this token (`calendarFeedLimiter`)
   */
  app.get("/calendars/:token.ics", calendarFeedLimiter, tryCatch(handleGetCalendarFeed));

  app.get("/health", (_, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: true, environment: config.api.env });
  });

  // Sentry's expressIntegration reports 5xx on its own; 4xx CustomErrors are left to errorMiddleware.
  app.use(errorMiddleware);

  return app;
};
