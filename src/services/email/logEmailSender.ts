import { logger } from "../../middleware/logger.js";
import type { EmailSender, TemplatedEmail } from "./emailSender.js";

/**
 * No-network {@link EmailSender} used in the `test` environment (and usable in
 * `dev` without AWS credentials). Mirrors the old `tempEmailSend` stub: it just
 * logs what would have been sent so tests never reach out to AWS SES.
 */
export const logEmailSender: EmailSender = {
  async sendTemplated({ to, template, data }: TemplatedEmail): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 25));
    logger.debug("logEmailSender.sendTemplated", { to, template, data });
  },
};
