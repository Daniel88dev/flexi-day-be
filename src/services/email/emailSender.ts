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
 * Variables required by the `email-confirmation` SES template. SES renders
 * missing variables as empty strings, so all fields must be present and
 * non-empty before sending — that applies to every template below too.
 */
export interface EmailConfirmationData {
  name: string;
  confirmationUrl: string;
  expiresIn: string;
}

/**
 * `password-reset`: sent by better-auth's sendResetPassword hook. Also the
 * only way a user who signed up through Google or Microsoft can acquire a
 * password — `resetPassword` creates the credential account when there is
 * none — so the template does not assume a previous password existed.
 */
export interface PasswordResetData {
  name: string;
  resetUrl: string;
  expiresIn: string;
}

/** `vacation-approval-request`: sent to a group approver. */
export interface VacationApprovalRequestData {
  approverName: string;
  employeeName: string;
  teamName: string;
  leaveType: string;
  dateRange: string;
  dayCount: string;
  /** Never empty — pass a placeholder such as "—" when there is no note. */
  note: string;
  requestUrl: string;
}

/** `vacation-approved`: sent to the requester. */
export interface VacationApprovedData {
  employeeName: string;
  approverName: string;
  teamName: string;
  leaveType: string;
  dateRange: string;
  dayCount: string;
  requestUrl: string;
}

/** `vacation-rejected`: sent to the requester. */
export interface VacationRejectedData extends VacationApprovedData {
  /** Never empty — pass a placeholder such as "—" when no reason was given. */
  reason: string;
}

/**
 * `vacation-cancelled`: sent to the requester when someone else cancels their
 * approved time off, or to the approvers when the requester cancels it.
 */
export interface VacationCancelledData {
  recipientName: string;
  employeeName: string;
  cancelledByName: string;
  teamName: string;
  leaveType: string;
  dateRange: string;
  dayCount: string;
  /** Never empty — pass a placeholder such as "—" when no reason was given. */
  reason: string;
  requestUrl: string;
}

/**
 * `vacation-comment`: sent to the other party when someone comments on a
 * request — to the requester when an approver comments, or to the approvers
 * when the requester comments.
 */
export interface VacationCommentData {
  recipientName: string;
  employeeName: string;
  commenterName: string;
  teamName: string;
  leaveType: string;
  dateRange: string;
  /** Never empty — the comment text. */
  message: string;
  requestUrl: string;
}

/**
 * `group-invite`: sent to someone an admin invited to join their group. The
 * code is deliberately in the email body only — `signUpUrl` is the plain
 * sign-up page and carries nothing, so a leaked link grants no access.
 */
export interface GroupInviteData {
  groupName: string;
  inviterName: string;
  inviteCode: string;
  /** Plain sign-up page, no token in it. */
  signUpUrl: string;
  /** Where an existing account redeems the code. */
  joinUrl: string;
  invitedEmail: string;
  expiresIn: string;
}

/**
 * `subscription-grace`: sent to the organization's billing email when a
 * payment fails or a subscription is canceled — full limits continue for the
 * grace window, then over-limit groups go read-only. Account/billing mail, so
 * it ignores `user_settings.emailNotifications`.
 */
export interface SubscriptionGraceData {
  recipientName: string;
  planName: string;
  /** Human-readable date the grace window ends, e.g. "25 August 2026". */
  graceEndsDate: string;
  billingUrl: string;
}

/**
 * A templated email to send. `template` is the logical template name; the
 * adapter maps it to the concrete, stage-suffixed SES template name. The
 * union keeps each template's variables tied to its name.
 */
export type TemplatedEmail =
  | { to: string; template: "email-confirmation"; data: EmailConfirmationData }
  | { to: string; template: "password-reset"; data: PasswordResetData }
  | { to: string; template: "vacation-approval-request"; data: VacationApprovalRequestData }
  | { to: string; template: "vacation-approved"; data: VacationApprovedData }
  | { to: string; template: "vacation-rejected"; data: VacationRejectedData }
  | { to: string; template: "vacation-cancelled"; data: VacationCancelledData }
  | { to: string; template: "vacation-comment"; data: VacationCommentData }
  | { to: string; template: "group-invite"; data: GroupInviteData }
  | { to: string; template: "subscription-grace"; data: SubscriptionGraceData };

export type EmailTemplateName = TemplatedEmail["template"];

export interface EmailSender {
  sendTemplated(email: TemplatedEmail): Promise<void>;
}
