import { z } from "zod";

export const validateConnectContextBody = z.object({
  /** The connect page's own query string, as the authorization server signed it. */
  oauthQuery: z.string().min(1).max(8192),
});

export type ConnectContextBody = z.infer<typeof validateConnectContextBody>;

export const validateConnectOrganizationBody = z.object({
  organizationId: z.string().min(1),
});

export type ConnectOrganizationBody = z.infer<typeof validateConnectOrganizationBody>;
