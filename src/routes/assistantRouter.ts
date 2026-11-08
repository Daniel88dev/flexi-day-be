import { Router, type Request } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import { requireAiFeature } from "../middleware/aiFeatureGuard.js";
import { validateCreateChat, validateSendMessage } from "../services/assistant/types.js";
import {
  handleDeleteChat,
  handleGetAssistantOrganizations,
  handleGetChat,
  handleGetChats,
  handleGetChatStream,
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
   *         or null while it runs); `notice` is a fixed message by `code`
   *         (`ASSISTANT_ERROR`).
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
   *         createdAt:
   *           type: string
   *           format: date-time
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
   *         - `card`: a confirmation card (pending actions, not sent yet).
   *         - `error` `{ code }`: a fixed message key, `ASSISTANT_ERROR`.
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
   *               required: [organizations]
   *               properties:
   *                 organizations:
   *                   type: array
   *                   items:
   *                     type: object
   *                     required: [organizationId, organizationName, eligible, reason, planAllows, role]
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
   *       while another runs gets 409. The answer streams as server-sent
   *       events (`AssistantChatStream`) until `done`. Closing the connection
   *       does not stop the answer; reconnect with `GET .../stream`.
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
   *       '503':
   *         description: '`ASSISTANT_UNAVAILABLE`: no driver can run the Assistant'
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

  return app;
};
