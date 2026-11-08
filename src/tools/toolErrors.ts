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
  "Help article not found": "Článek nápovědy nebyl nalezen.",
  "The help articles aren't available right now. Try again later.":
    "Články nápovědy teď nejsou k dispozici. Zkuste to později.",
  "Person not found": "Osoba nebyla nalezena.",
  "No access to view this group's records": "Záznamy této skupiny nemáte oprávnění zobrazit.",
  "No employment in this organization": "V této organizaci nemáte pracovní poměr.",
  "No access to this group's events": "K událostem této skupiny nemáte přístup.",
  "Organization not found": "Organizace nebyla nalezena.",
  "The people directory requires the Enterprise plan":
    "Adresář lidí je součástí tarifu Enterprise.",
  "The directory is off in this organization": "Adresář je v této organizaci vypnutý.",
  "You are not one of this organization's people": "Mezi lidi této organizace nepatříte.",
  "You can't read this Section": "Tuto sekci nemůžete číst.",
  "The Personal Section applies to employees only": "Osobní údaje se týkají jen zaměstnanců.",
  "No access for related group": "V této skupině si volno zadávat nemůžete.",
  "You book time off in more than one group here, so the group has to be named":
    "Volno si zadáváte ve více skupinách této organizace, takže je potřeba skupinu uvést.",
  "This request is not valid": "Tato žádost není platná.",
  "Selected day is a public holiday": "Vybraný den je státní svátek.",
  "Selected day is not a working day": "Vybraný den není pracovní.",
  "Selected range contains no working days": "Vybrané období neobsahuje žádný pracovní den.",
  "This would exceed the allowance for that leave type":
    "Tím byste překročili nárok na tento typ volna.",
  "External workers book only leave that draws on no allowance":
    "Externí pracovníci si zadávají jen volno, které nečerpá z nároku.",
  "This group is read-only on your current plan":
    "Tato skupina je ve vašem současném tarifu jen pro čtení.",
  "The Sick day benefit is not enabled for this organization":
    "Benefit zdravotního volna není v této organizaci zapnutý.",
  "Request not found": "Žádost nebyla nalezena.",
  "One or more vacations not found": "Některé dny žádosti nebyly nalezeny.",
  "You are not allowed to cancel one or more of these vacations":
    "Některé dny této žádosti nemůžete zrušit.",
  "One or more of these requests has already been cancelled": "Žádost už byla zrušena.",
  "You are already clocked in": "Příchod už máte zaznamenaný.",
  "You are not clocked in": "Nemáte zaznamenaný příchod.",
  "This employment has ended": "Tento pracovní poměr skončil.",
  "External workers don't record attendance": "Externí pracovníci docházku nezaznamenávají.",
  "Attendance requires a paid plan": "Docházka vyžaduje placený tarif.",
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
