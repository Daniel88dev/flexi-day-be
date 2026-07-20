import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { config } from "../../config.js";
import type { EmailSender, TemplatedEmail } from "./emailSender.js";

const client = new SESv2Client({ region: config.email.region });

/**
 * Resolves the logical template name to the concrete, stage-suffixed SES
 * template name, e.g. `email-confirmation` -> `flexi-day-email-confirmation-prod`.
 */
const resolveTemplateName = (template: TemplatedEmail["template"]): string =>
  `flexi-day-${template}-${config.email.templateStage}`;

/**
 * Guards against sending a template with blank variables. SES silently
 * renders missing/empty variables as empty strings, which would produce a
 * broken email, so we fail fast instead.
 */
const assertNonEmptyData = (data: Record<string, unknown>): void => {
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`Missing or empty template variable: "${key}"`);
    }
  }
};

/**
 * SES adapter for {@link EmailSender}. Calls SESv2 `SendEmail` with the
 * `Template` content type; the HTML/text bodies live in native SES templates,
 * not in this codebase.
 */
export const sesEmailSender: EmailSender = {
  async sendTemplated({ to, template, data }: TemplatedEmail): Promise<void> {
    assertNonEmptyData(data as unknown as Record<string, unknown>);

    await client.send(
      new SendEmailCommand({
        FromEmailAddress: config.email.from,
        Destination: { ToAddresses: [to] },
        ConfigurationSetName: config.email.configurationSet,
        Content: {
          Template: {
            TemplateName: resolveTemplateName(template),
            TemplateData: JSON.stringify(data),
          },
        },
      })
    );
  },
};
