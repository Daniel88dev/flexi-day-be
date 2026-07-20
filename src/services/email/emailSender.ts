/**
 * Domain-facing port for transactional email. Callers depend on this
 * interface only and never touch the AWS SDK directly, so the underlying
 * provider (SES today) can be swapped without changing business code.
 *
 * The rendered content lives in native SES templates (managed by the
 * `flexi-day-emails` repo); this codebase only supplies the template name and
 * the data variables.
 */

/**
 * A templated email to send. `template` is the logical template name; the
 * adapter maps it to the concrete, stage-suffixed SES template name.
 */
export interface TemplatedEmail {
  to: string;
  template: "email-confirmation";
  data: EmailConfirmationData;
}

/**
 * Variables required by the `email-confirmation` SES template. SES renders
 * missing variables as empty strings, so all fields must be present and
 * non-empty before sending.
 */
export interface EmailConfirmationData {
  name: string;
  confirmationUrl: string;
  expiresIn: string;
}

export interface EmailSender {
  sendTemplated(email: TemplatedEmail): Promise<void>;
}
