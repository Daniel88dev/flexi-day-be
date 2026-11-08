import * as Sentry from "@sentry/node";
import { logger } from "../middleware/logger.js";
import AppError from "../utils/appError.js";
import { errorName } from "../utils/errorName.js";
import type { ToolLanguage } from "./types.js";

/**
 * A refused or failed tool run as the model receives it. `message` is written
 * here or is a guard's public message, never text built from a user's words
 * or the tool's arguments; `context` carries only a guard's public context.
 */
export type ToolError = { message: string; context?: Record<string, unknown> };

/** The messages the tool layer and its adapters write themselves. */
export const TOOL_MESSAGES = {
  UNKNOWN_TOOL: {
    en: "There is no tool with this name.",
    cs: "Nástroj s tímto názvem neexistuje.",
  },
  INVALID_ARGUMENTS: {
    en: "The arguments don't match this tool's input schema.",
    cs: "Argumenty neodpovídají vstupnímu schématu tohoto nástroje.",
  },
  READ_ONLY: {
    en: "This connection can only read Flexi Day data. It can't make changes.",
    cs: "Toto připojení může data ve Flexi Day jen číst. Změny dělat nemůže.",
  },
  INTERNAL: {
    en: "Something went wrong in Flexi Day. Try again later.",
    cs: "Ve Flexi Day se něco pokazilo. Zkuste to později.",
  },
  NO_STANDING: {
    en: "You are no longer part of this organization, so this connection can't read its data. Connect again for an organization you belong to.",
    cs: "Do této organizace už nepatříte, takže toto připojení nemůže číst její data. Připojte se znovu k organizaci, do které patříte.",
  },
  PLAN: {
    en: "This organization's plan no longer includes AI connections. The owner can renew the plan in Flexi Day.",
    cs: "Tarif této organizace už nezahrnuje AI připojení. Vlastník může tarif obnovit ve Flexi Day.",
  },
} as const satisfies Record<string, Record<ToolLanguage, string>>;

export type ToolMessage = keyof typeof TOOL_MESSAGES;

export const toolMessage = (key: ToolMessage, language: ToolLanguage): ToolError => ({
  message: TOOL_MESSAGES[key][language],
  context: { code: key },
});

/**
 * Czech for the public messages of the guards the tools reach, keyed by the
 * English message. A message missing here goes out in English; a tool that
 * reaches a new guard adds its message.
 */
const GUARD_MESSAGES_CS: Record<string, string> = {
  "Group not found": "Skupina nebyla nalezena.",
  "Person not found": "Osoba nebyla nalezena.",
  "No access to view this group's records": "Záznamy této skupiny nemáte oprávnění zobrazit.",
};

/**
 * A guard's refusal (an `AppError` below 500) keeps its public message and
 * public context. Anything else is reported and reaches the model as one fixed
 * message, because its text may hold query values.
 */
export const toToolError = (
  error: unknown,
  language: ToolLanguage,
  toolName: string
): ToolError => {
  if (error instanceof AppError && error.statusCode < 500) {
    const publicContext = error.errors[0]?.publicContext ?? {};
    return {
      message: (language === "cs" ? GUARD_MESSAGES_CS[error.message] : undefined) ?? error.message,
      ...(Object.keys(publicContext).length > 0 ? { context: publicContext } : {}),
    };
  }
  logger.error("tool.failed", { tool: toolName, error: errorName(error) });
  Sentry.captureException(error, { tags: { "gen_ai.tool.name": toolName } });
  return toolMessage("INTERNAL", language);
};
