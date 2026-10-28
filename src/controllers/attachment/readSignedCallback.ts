import type { Request } from "express";
import type { z } from "zod";
import { config } from "../../config.js";
import AppError from "../../utils/appError.js";
import {
  ATTACHMENT_SIGNATURE_HEADER,
  verifyAttachmentCallback,
} from "../../services/attachment/callbackSignature.js";

/**
 * The body of a report the `attachment-processor` Lambda signed, checked
 * against `schema`. The HMAC over the raw body is the only credential: 401
 * without it, 422 when the body does not parse.
 */
export const readSignedCallback = <Schema extends z.ZodType>(
  req: Request,
  schema: Schema,
  callback: "attachment" | "photo"
): z.output<Schema> => {
  const secret = config.attachments.callbackSecret;
  const body: unknown = req.body;
  const signature = req.header(ATTACHMENT_SIGNATURE_HEADER);
  if (!secret || !Buffer.isBuffer(body) || !verifyAttachmentCallback(secret, body, signature)) {
    throw new AppError({
      message: `Invalid ${callback} callback signature`,
      logging: true,
      code: 401,
    });
  }

  const parsed = schema.safeParse(parseJson(body));
  if (!parsed.success) {
    throw new AppError({
      message: `Malformed ${callback} callback`,
      logging: true,
      code: 422,
      context: { issues: parsed.error.issues },
    });
  }
  return parsed.data;
};

const parseJson = (body: Buffer): unknown => {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
};
