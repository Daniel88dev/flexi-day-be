import { config } from "../../config.js";
import type { EmailSender } from "./emailSender.js";
import { sesEmailSender } from "./sesEmailSender.js";
import { logEmailSender } from "./logEmailSender.js";

export type {
  EmailSender,
  EmailTemplateName,
  TemplatedEmail,
  EmailConfirmationData,
  VacationApprovalRequestData,
  VacationApprovedData,
  VacationCancelledData,
  VacationRejectedData,
} from "./emailSender.js";

/**
 * The active email sender. Tests use the log-only sender so they never hit
 * AWS; every other environment uses the real SES adapter.
 */
export const emailSender: EmailSender = config.api.env === "test" ? logEmailSender : sesEmailSender;
