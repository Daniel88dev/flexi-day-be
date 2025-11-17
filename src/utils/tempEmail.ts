import { logger } from "../middleware/logger.js";
import { config } from "../config.js";

type TempEmailType = {
  to: string;
  subject: string;
  text: string;
};

// todo this is temporary email sending for development purposes just logging to console
export const tempEmailSend = async (emailData: TempEmailType) => {
  if (config.api.env === "production") {
    logger.warn("tempEmail.send called in production. skipping.");
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
  logger.debug("tempEmail.send", {
    to: emailData.to,
    subject: emailData.subject,
    bodyPreviewChars: Math.min(emailData.text.length, 100),
  });
};
