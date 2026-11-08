import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { logger } from "../../middleware/logger.js";
import {
  createChat,
  deleteChat,
  getChatDetail,
  getOwnChat,
  listAssistantOrganizations,
  listChats,
} from "../../services/assistant/chatServices.js";
import { projectTurn, type ChatStreamSink } from "../../services/assistant/chatStream.js";
import { assistantDriver } from "../../services/assistant/driver/index.js";
import { prepareTurn, sendTurn } from "../../services/assistant/turnServices.js";
import {
  ASSISTANT_NOTICE,
  validateStreamQuery,
  type ValidatedCreateChat,
  type ValidatedSendMessage,
} from "../../services/assistant/types.js";
import AppError from "../../utils/appError.js";
import { errorName } from "../../utils/errorName.js";
import { requirePathParam } from "../pathParams.js";

/** Opens an SSE response; the sink writes one event per call and ignores writes after the close. */
const openStream = (res: Response): { sink: ChatStreamSink; signal: AbortSignal } => {
  const closed = new AbortController();
  res.on("close", () => closed.abort());
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const sink: ChatStreamSink = (event, data, id) => {
    if (closed.signal.aborted) return;
    res.write(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  return { sink, signal: closed.signal };
};

/** Once the stream is open the status is sent; a late failure becomes `error` then `done`. */
const finishWithError = (res: Response, sink: ChatStreamSink, error: unknown) => {
  logger.error("assistant.stream_failed", { error: errorName(error) });
  sink("error", { code: ASSISTANT_NOTICE.ERROR });
  sink("done", {});
  res.end();
};

export const handleGetAssistantOrganizations = async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  res.status(200).json({ organizations: await listAssistantOrganizations(userId) });
};

export const handleGetChats = async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  res.status(200).json({ chats: await listChats(userId) });
};

export const handlePostChat = async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  const { organizationId } = req.body as ValidatedCreateChat;
  res.status(201).json({ chat: await createChat({ userId, organizationId }) });
};

export const handleGetChat = async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  const chatId = requirePathParam(req.params.chatId, "chatId");
  res.status(200).json(await getChatDetail({ userId, chatId }));
};

export const handleDeleteChat = async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  const chatId = requirePathParam(req.params.chatId, "chatId");
  await deleteChat({ userId, chatId });
  res.status(204).end();
};

export const handlePostChatMessage = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const chatId = requirePathParam(req.params.chatId, "chatId");
  const { text } = req.body as ValidatedSendMessage;
  const turn = await prepareTurn({ auth, chatId, text });

  const { sink, signal } = openStream(res);
  try {
    await projectTurn({
      driver: turn.driver,
      chatId: turn.chatId,
      sessionId: turn.sessionId,
      afterId: () => sendTurn(turn),
      signal,
      sink,
    });
    res.end();
  } catch (error) {
    finishWithError(res, sink, error);
  }
};

export const handleGetChatStream = async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  const chatId = requirePathParam(req.params.chatId, "chatId");
  const query = validateStreamQuery.safeParse(req.query);
  if (!query.success) throw new AppError({ message: "Invalid event id", code: 400 });
  const chat = await getOwnChat({ userId, chatId });
  const driver = assistantDriver();

  const { sink, signal } = openStream(res);
  try {
    await projectTurn({
      driver,
      chatId: chat.id,
      sessionId: chat.sessionId,
      afterId: query.data.after ?? chat.turnStartEventId,
      signal,
      sink,
    });
    res.end();
  } catch (error) {
    finishWithError(res, sink, error);
  }
};
