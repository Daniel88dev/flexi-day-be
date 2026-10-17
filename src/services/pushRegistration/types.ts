import { z } from "zod";
import { pushEnvironment } from "../../db/schema/push-registration-schema.js";

/** 32 bytes today; Apple says the length may grow, so allow up to 100. */
const APNS_TOKEN = /^(?:[0-9a-f]{2}){32,100}$/;

export const validatePutPushRegistration = z.object({
  token: z
    .string()
    .transform((token) => token.toLowerCase())
    .pipe(z.string().regex(APNS_TOKEN)),
  environment: z.enum(pushEnvironment),
});

export type PutPushRegistrationBody = z.infer<typeof validatePutPushRegistration>;
