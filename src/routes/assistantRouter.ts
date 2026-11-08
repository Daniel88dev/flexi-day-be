import * as Sentry from "@sentry/node";
import { Router, type Request } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import { requireAiFeature } from "../middleware/aiFeatureGuard.js";
import {
  validateCardConfirm,
  validateCreateChat,
  validateSendMessage,
} from "../services/assistant/types.js";
import {
  handleDeleteChat,
  handleGetAssistantOrganizations,
  handleGetChat,
  handleGetChats,
  handleGetChatStream,
  handlePostCardDecision,
  handlePostChat,
  handlePostChatMessage,
} from "../controllers/assistant/assistantHandlers.js";

const bodyOrganizationId = (req: Request): string | undefined => {
  const body = req.body as { organizationId?: unknown } | undefined;
  return typeof body?.organizationId === "string" ? body.organizationId : undefined;
};

/** Mounted behind `authSession` and `requireAiFeature("assistant", "caller")`. */
export const assistantRouter = (): Router => {
  const app = Router();
  // The chat id is Sentry's conversation id for everything the request traces.
  app.param("chatId", (_req, _res, next, chatId: string) => {
    Sentry.setConversationId(chatId);
    next();
  });

  /**
   * @openapi
   * components:
   *   schemas:
   *     AssistantChat:
   *       type: object
   *       required: [id, organizationId, organizationName, title, createdAt, lastMessageAt, turnRunning]
   *       properties:
   *         id:
   *           type: string
   *           format: uuid
   *         organizationId:
   *           type: string
   *           format: uuid
   *         organizationName:
   *           type: string
   *         title:
   *           type: string
   *           nullable: true
   *           maxLength: 80
   *           description: The start of the first message; null until one is sent.
   *         createdAt:
   *           type: string
   *           format: date-time
   *         lastMessageAt:
   *           type: string
   *           format: date-time
   *         turnRunning:
   *           type: boolean
   *           description: An answer is being written; reconnect with `GET /chats/{chatId}/stream`.
   *     AssistantDisplayMessage:
   *       type: object
   *       description: |
   *         One row of the display record, in order. `user` and `assistant`
   *         carry `text`; `tool` is an activity line with the tool's name and
   *         outcome (`ok`, `refused`, `failed`, `invalid_arguments`, `read_only`,
   *         `card` for a write waiting on or settled by its confirmation card,
   *         `stopped` when the Weekly limit or the turn's 10 model calls stopped
   *         the turn before its result was sent (the next message carries it),
   *         or null while it runs);
   *         `notice` is a fixed message by `code` (`ASSISTANT_ERROR`,
   *         `ASSISTANT_TOPIC_REFUSAL`, `ASSISTANT_MODEL_REFUSAL`,
   *         `ASSISTANT_WEEKLY_LIMIT_REACHED`, `ASSISTANT_STEP_LIMIT`,
   *         `ASSISTANT_UNAVAILABLE`). A `user` row with `code` `REJECTED` is
   *         a message the screen kept from the session; the topic refusal
   *         notice follows it.
   *       required: [id, kind, text, toolName, toolOutcome, code, createdAt]
   *       properties:
   *         id:
   *           type: string
   *           format: uuid
   *         kind:
   *           type: string
   *           enum: [user, assistant, tool, notice]
   *         text:
   *           type: string
   *           nullable: true
   *         toolName:
   *           type: string
   *           nullable: true
   *         toolOutcome:
   *           type: string
   *           nullable: true
   *         code:
   *           type: string
   *           nullable: true
   *         card:
   *           nullable: true
   *           description: On a write's tool line (`toolOutcome` `card`), its confirmation card.
   *           allOf:
   *             - $ref: '#/components/schemas/AssistantCard'
   *         createdAt:
   *           type: string
   *           format: date-time
   *     AssistantCard:
   *       type: object
   *       description: |
   *         A write the Assistant asked for, waiting on the user: a pending
   *         action. Its content is the write tool's preview, a dry run of the
   *         same guards, never the model's words. `status` is `open` until the
   *         user confirms or declines it, or `not_taken` once the user sent a
   *         new message instead. `error` is the reason the last confirm was
   *         refused; the card stays open to try again. `authorNames` lists the
   *         people other than the user whose notes the Assistant read earlier
   *         in the turn.
   *       required: [id, chatId, toolUseId, tool, status, preview, authorNames, result, error, createdAt, decidedAt]
   *       properties:
   *         id:
   *           type: string
   *           format: uuid
   *         chatId:
   *           type: string
   *           format: uuid
   *         toolUseId:
   *           type: string
   *           description: The session's tool call; `tool` stream events carry the same id.
   *         tool:
   *           type: string
   *           enum: [create_request, cancel_my_request, clock_in, clock_out]
   *         status:
   *           type: string
   *           enum: [open, confirmed, declined, not_taken]
   *         preview:
   *           type: object
   *           description: The tool's preview, keyed by `action` (the tool name), with user-written strings plain.
   *           additionalProperties: true
   *         authorNames:
   *           type: array
   *           items:
   *             type: string
   *         result:
   *           type: object
   *           nullable: true
   *           description: The write's result once confirmed.
   *           additionalProperties: true
   *         error:
   *           type: object
   *           nullable: true
   *           required: [message, code]
   *           properties:
   *             message:
   *               type: string
   *               description: In the user's app language.
   *             code:
   *               type: string
   *               nullable: true
   *         createdAt:
   *           type: string
   *           format: date-time
   *         decidedAt:
   *           type: string
   *           format: date-time
   *           nullable: true
   *     AssistantCardDecision:
   *       type: object
   *       required: [card, turnRunning]
   *       properties:
   *         card:
   *           $ref: '#/components/schemas/AssistantCard'
   *         turnRunning:
   *           type: boolean
   *           description: |
   *             The decision sent the card's round and the Assistant is writing
   *             on; follow it with `GET /chats/{chatId}/stream`. False while
   *             another card of the same response is open, after a refused
   *             confirm, or when the Weekly limit holds the result for the next
   *             message.
   *     AssistantChatStream:
   *       type: string
   *       description: |
   *         Server-sent events, each `event:` one of five, `data:` JSON. Events
   *         recorded in the session carry their session event id as `id:`;
   *         send the last one back as `after` to reconnect without duplicates.
   *         - `text` `{ delta }`: live text, no id, lost on reconnect.
   *         - `text` `{ eventId, text }`: one finished Assistant message; it
   *           replaces the deltas before it.
   *         - `tool` `{ eventId, name, status }`: a tool call, `status` is
   *           `running`, then `done` or `failed` under the same `eventId`.
   *         - `card` (`AssistantCard`): a write waiting on the user's
   *           confirmation, sent once the response's calls are handled. The
   *           answer then ends with `done`; nothing runs until a decision.
   *         - `error` `{ code }`: a fixed message key: `ASSISTANT_ERROR`,
   *           `ASSISTANT_TOPIC_REFUSAL` (the screen rejected the message, which
   *           never reached the session) or `ASSISTANT_MODEL_REFUSAL` (the
   *           model refused; the turn ends without a retry).
   *           `ASSISTANT_WEEKLY_LIMIT_REACHED` (the Weekly limit stopped the
   *           turn; streamed text stays), `ASSISTANT_STEP_LIMIT` (10 model
   *           calls), `ASSISTANT_UNAVAILABLE` (Anthropic's spend limit or credits).
   *         - `done` `{}`: the turn ended; the display record has it all.
   */

  /**
   * @openapi
   * /api/assistant/organizations:
   *   get:
   *     tags:
   *       - Assistant
   *     summary: The caller's organizations for the Assistant's picker and button
   *     description: |
   *       Every organization the caller has standing in, oldest first, with the
   *       eligibility answer the OAuth picker shares (standing, the Assistant
   *       available and on, an Enterprise or Custom plan). Organizations where
   *       the Assistant is unavailable (kill switch off, not on the preview
   *       list) are left out. `planAllows` and `role` drive the web app's
   *       button: an owner without Enterprise gets the upgrade prompt, an
   *       owner or org admin with the Assistant off gets "The Assistant is off".
   *
   *       `weeklyLimit` is this week's Usage against the organization's Weekly
   *       limit, for eligible organizations: "used" is settled plus reserved
   *       steps of the UTC week (Monday 00:00 UTC, by the database clock).
   *       Owners and org admins get the amounts; members get `percent`,
   *       `reached` and `resetsAt` with the amounts `null`.
   *       `providerUnavailable` is true for every caller for a few minutes
   *       after Anthropic refused for its spend limit or credits.
   *     operationId: handleGetAssistantOrganizations
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: The organizations
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [organizations, providerUnavailable]
   *               properties:
   *                 providerUnavailable:
   *                   type: boolean
   *                 organizations:
   *                   type: array
   *                   items:
   *                     type: object
   *                     required: [organizationId, organizationName, eligible, reason, planAllows, role, weeklyLimit]
   *                     properties:
   *                       organizationId:
   *                         type: string
   *                         format: uuid
   *                       organizationName:
   *                         type: string
   *                       eligible:
   *                         type: boolean
   *                       reason:
   *                         type: string
   *                         nullable: true
   *                         enum: [NO_STANDING, TURNED_OFF, PLAN]
   *                       planAllows:
   *                         type: boolean
   *                       role:
   *                         type: string
   *                         enum: [owner, admin, member]
   *                       weeklyLimit:
   *                         type: object
   *                         nullable: true
   *                         required: [percent, reached, resetsAt, usedMicroUsd, limitMicroUsd]
   *                         properties:
   *                           percent:
   *                             type: integer
   *                             minimum: 0
   *                             maximum: 100
   *                           reached:
   *                             type: boolean
   *                             description: Even the smallest step would pass the limit; no turn can start.
   *                           resetsAt:
   *                             type: string
   *                             format: date-time
   *                           usedMicroUsd:
   *                             type: integer
   *                             nullable: true
   *                             description: Settled plus reserved, in micro-USD; `null` for members.
   *                           limitMicroUsd:
   *                             type: integer
   *                             nullable: true
   *                             description: The Weekly limit in micro-USD; `null` for members.
   *       '401':
   *         description: Not signed in
   *       '404':
   *         description: The Assistant is unavailable to the caller
   */
  app.get("/organizations", tryCatch(handleGetAssistantOrganizations));

  /**
   * @openapi
   * /api/assistant/chats:
   *   get:
   *     tags:
   *       - Assistant
   *     summary: The caller's chats
   *     description: Newest activity first, only in organizations where the Assistant is available.
   *     operationId: handleGetChats
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: The chats
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [chats]
   *               properties:
   *                 chats:
   *                   type: array
   *                   items:
   *                     $ref: '#/components/schemas/AssistantChat'
   *       '401':
   *         description: Not signed in
   *       '404':
   *         description: The Assistant is unavailable to the caller
   *   post:
   *     tags:
   *       - Assistant
   *     summary: Open a chat in one organization
   *     description: |
   *       Refused unless the caller has standing in the organization, the
   *       Assistant is on there and the plan is Enterprise or Custom. A chat
   *       stays in the organization it starts in.
   *     operationId: handlePostChat
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [organizationId]
   *             properties:
   *               organizationId:
   *                 type: string
   *                 format: uuid
   *     responses:
   *       '201':
   *         description: The new chat
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [chat]
   *               properties:
   *                 chat:
   *                   $ref: '#/components/schemas/AssistantChat'
   *       '400':
   *         description: Invalid body
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: |
   *           `AI_ORGANIZATION_NOT_ELIGIBLE` with `reason` `NO_STANDING`,
   *           `TURNED_OFF` or `PLAN`
   *       '404':
   *         description: The Assistant is unavailable in this organization
   */
  app.get("/chats", tryCatch(handleGetChats));
  app.post(
    "/chats",
    bodyValidationMiddleware(validateCreateChat),
    requireAiFeature("assistant", { organizationId: bodyOrganizationId }),
    tryCatch(handlePostChat)
  );

  /**
   * @openapi
   * /api/assistant/chats/{chatId}:
   *   get:
   *     tags:
   *       - Assistant
   *     summary: One chat and its display record
   *     description: |
   *       Readable while the Assistant is available in the chat's
   *       organization, even after the owner turns it off or the plan lapses.
   *     operationId: handleGetChat
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: chatId
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     responses:
   *       '200':
   *         description: The chat
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [chat, messages]
   *               properties:
   *                 chat:
   *                   $ref: '#/components/schemas/AssistantChat'
   *                 messages:
   *                   type: array
   *                   items:
   *                     $ref: '#/components/schemas/AssistantDisplayMessage'
   *       '401':
   *         description: Not signed in
   *       '404':
   *         description: Not the caller's chat, or the Assistant is unavailable in its organization
   *   delete:
   *     tags:
   *       - Assistant
   *     summary: Delete a chat
   *     description: Deletes the chat, its display record and its session at once.
   *     operationId: handleDeleteChat
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: chatId
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     responses:
   *       '204':
   *         description: Deleted
   *       '401':
   *         description: Not signed in
   *       '404':
   *         description: Not the caller's chat, or the Assistant is unavailable in its organization
   */
  app.get("/chats/:chatId", tryCatch(handleGetChat));
  app.delete("/chats/:chatId", tryCatch(handleDeleteChat));

  /**
   * @openapi
   * /api/assistant/chats/{chatId}/messages:
   *   post:
   *     tags:
   *       - Assistant
   *     summary: Send a message; the answer streams back
   *     description: |
   *       Checks the organization again (standing, Assistant on, plan), so a
   *       chat stays readable after the Assistant is turned off but takes no
   *       more messages. One answer at a time per user, across chats: a send
   *       while another runs gets 409. The screen then checks the message
   *       first: off topic or an attack, the message is recorded as rejected
   *       and the stream answers `error` `ASSISTANT_TOPIC_REFUSAL` then `done`,
   *       and nothing reaches the session. Otherwise the answer streams as
   *       server-sent events (`AssistantChatStream`) until `done`. Closing the
   *       connection does not stop the answer; reconnect with `GET .../stream`.
   *       Each step, the screen included, is reserved against the
   *       organization's Weekly limit first; a send whose first step would
   *       pass it is refused with 429 and writes nothing.
   *     operationId: handlePostChatMessage
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: chatId
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
   *             required: [text]
   *             properties:
   *               text:
   *                 type: string
   *                 minLength: 1
   *                 maxLength: 4000
   *     responses:
   *       '200':
   *         description: The answer as an event stream
   *         content:
   *           text/event-stream:
   *             schema:
   *               $ref: '#/components/schemas/AssistantChatStream'
   *       '400':
   *         description: Invalid body
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: |
   *           `AI_ORGANIZATION_NOT_ELIGIBLE` with `reason` `NO_STANDING`,
   *           `TURNED_OFF` or `PLAN`
   *       '404':
   *         description: Not the caller's chat, or the Assistant is unavailable in its organization
   *       '409':
   *         description: '`ASSISTANT_TURN_RUNNING`: another answer of the caller''s is being written'
   *       '429':
   *         description: |
   *           `ASSISTANT_WEEKLY_LIMIT_REACHED` with `resetsAt`: the organization
   *           reached this week's Assistant limit. Nothing is written or charged.
   *       '503':
   *         description: |
   *           `ASSISTANT_UNAVAILABLE`: no driver can run the Assistant, or
   *           Anthropic refused for its spend limit or credits.
   *           `ASSISTANT_SCREEN_FAILED`: the screen failed or timed out; the
   *           message was neither recorded nor sent, so send it again.
   */
  app.post(
    "/chats/:chatId/messages",
    bodyValidationMiddleware(validateSendMessage),
    tryCatch(handlePostChatMessage)
  );

  /**
   * @openapi
   * /api/assistant/chats/{chatId}/stream:
   *   get:
   *     tags:
   *       - Assistant
   *     summary: Reconnect to the answer being written
   *     description: |
   *       Replays the current answer's recorded events after `after` (or from
   *       its start), each once, then tails it until `done`. Live text written
   *       before the reconnect is not replayed; the finished message arrives
   *       as one `text`. With no answer running it sends what remains and
   *       `done`.
   *     operationId: handleGetChatStream
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: chatId
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *       - in: query
   *         name: after
   *         required: false
   *         schema:
   *           type: string
   *           pattern: '^[A-Za-z0-9_]{1,128}$'
   *         description: The last event id the client received.
   *     responses:
   *       '200':
   *         description: The answer as an event stream
   *         content:
   *           text/event-stream:
   *             schema:
   *               $ref: '#/components/schemas/AssistantChatStream'
   *       '400':
   *         description: Invalid event id
   *       '401':
   *         description: Not signed in
   *       '404':
   *         description: Not the caller's chat, or the Assistant is unavailable in its organization
   */
  app.get("/chats/:chatId/stream", tryCatch(handleGetChatStream));

  /**
   * @openapi
   * /api/assistant/pending-actions/{pendingActionId}/confirm:
   *   post:
   *     tags:
   *       - Assistant
   *     summary: Confirm a card; the write runs
   *     description: |
   *       Runs the card's stored arguments with fresh guards, marked as made
   *       through the Assistant. A refusal by the guards answers 200 with the
   *       card still `open` and `error` set, to try again. Once every card of
   *       the Assistant's response is decided, the results go to the session
   *       and the Assistant writes on (`turnRunning`). At the Weekly limit
   *       the write still runs and the card settles, but the result is held
   *       and sent with the user's next admitted message.
   *
   *       A reject card (`reject_request`) takes the requester's reason from
   *       the body, replacing the one the Assistant proposed; blank or null
   *       rejects without one. The session hears only whether a reason was
   *       given, never its text.
   *     operationId: handleConfirmPendingAction
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: pendingActionId
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     requestBody:
   *       required: false
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               reason:
   *                 type: string
   *                 nullable: true
   *                 maxLength: 1000
   *                 description: Reject cards only. The reason the requester reads.
   *     responses:
   *       '200':
   *         description: The card after the decision
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AssistantCardDecision'
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: |
   *           `AI_ORGANIZATION_NOT_ELIGIBLE` with `reason` `NO_STANDING`,
   *           `TURNED_OFF` or `PLAN`
   *       '404':
   *         description: Not the caller's card, or the Assistant is unavailable in its organization
   *       '409':
   *         description: |
   *           `PENDING_ACTION_SETTLED` with `status`: the card was already
   *           decided or not taken. `ASSISTANT_TURN_RUNNING`: another answer
   *           of the caller's is being written.
   *       '422':
   *         description: |
   *           A `reason` longer than 1000 characters, or a `reason` on a card
   *           other than a reject (`REASON_NOT_ALLOWED`).
   *       '503':
   *         description: '`ASSISTANT_UNAVAILABLE`: Anthropic refused for its spend limit or credits.'
   */
  app.post(
    "/pending-actions/:pendingActionId/confirm",
    bodyValidationMiddleware(validateCardConfirm),
    tryCatch(handlePostCardDecision("confirm"))
  );

  /**
   * @openapi
   * /api/assistant/pending-actions/{pendingActionId}/decline:
   *   post:
   *     tags:
   *       - Assistant
   *     summary: Decline a card ("Not now", "Keep it")
   *     description: |
   *       Nothing changes. The card settles as `declined` and the Assistant
   *       is told the user declined, once every card of its response is
   *       decided.
   *     operationId: handleDeclinePendingAction
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: pendingActionId
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     responses:
   *       '200':
   *         description: The card after the decision
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AssistantCardDecision'
   *       '401':
   *         description: Not signed in
   *       '403':
   *         description: |
   *           `AI_ORGANIZATION_NOT_ELIGIBLE` with `reason` `NO_STANDING`,
   *           `TURNED_OFF` or `PLAN`
   *       '404':
   *         description: Not the caller's card, or the Assistant is unavailable in its organization
   *       '409':
   *         description: '`PENDING_ACTION_SETTLED` or `ASSISTANT_TURN_RUNNING`'
   *       '503':
   *         description: '`ASSISTANT_UNAVAILABLE`: Anthropic refused for its spend limit or credits.'
   */
  app.post(
    "/pending-actions/:pendingActionId/decline",
    tryCatch(handlePostCardDecision("decline"))
  );

  return app;
};
