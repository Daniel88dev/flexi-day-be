import { logger } from "../middleware/logger.js";

type TempEmailType = {
  to: string;
  subject: string;
  text: string;
};

// todo this is temporary email sending for development purposes just logging to console
export const tempEmailSend = async (emailData: TempEmailType) => {
  await new Promise((resolve) => setTimeout(resolve, 25));
  logger.info("tempEmail.send", {
    to: emailData.to,
    subject: emailData.subject,
    bodyPreviewChars: Math.min(emailData.text.length, 100),
  });
};
