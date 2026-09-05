import { S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import {
  ATTACHMENT_SIGNATURE_HEADER,
  signAttachmentCallback,
} from "../../services/attachment/callbackSignature.js";
import {
  ATTACHMENT_GONE_REASON,
  type AttachmentProcessedPayload,
} from "../../services/attachment/types.js";
import { createHandler, type NotifyResult } from "./handler.js";
import { createS3ObjectStore } from "./s3ObjectStore.js";

/**
 * The Lambda entry point. Bundled by `lambda/attachment-processor/build.mjs`
 * together with the shared processor; nothing here may import the API's
 * config, database or store.
 */

const env = (name: string): string => {
  // eslint-disable-next-line security/detect-object-injection
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
};

const bucket = env("ATTACHMENTS_BUCKET");
const apiUrl = env("API_URL");
const callbackSecretArn = env("ATTACHMENTS_CALLBACK_SECRET_ARN");

const store = createS3ObjectStore(new S3Client({}), bucket);

// Read once per container; a failed read is not cached so the next event retries.
let callbackSecret: Promise<string> | undefined;
const getCallbackSecret = () =>
  (callbackSecret ??= new SecretsManagerClient({})
    .send(new GetSecretValueCommand({ SecretId: callbackSecretArn }))
    .then((secret) => {
      if (!secret.SecretString) throw new Error("Attachment callback secret is empty");
      return secret.SecretString;
    })
    .catch((error: unknown) => {
      callbackSecret = undefined;
      throw error;
    }));

const notify = async (payload: AttachmentProcessedPayload): Promise<NotifyResult> => {
  const body = JSON.stringify(payload);
  const response = await fetch(new URL("/api/attachments/processed", apiUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [ATTACHMENT_SIGNATURE_HEADER]: signAttachmentCallback(await getCallbackSecret(), body),
    },
    body,
  });
  // 409: an earlier delivery already moved the row. 404 with the API's own
  // reason: the row was deleted while the bytes were in flight, so the
  // handler drops what it wrote. Any other 404 is a misrouted callback.
  if (response.ok) return "applied";
  if (response.status === 409) return "already";
  const text = await response.text();
  if (response.status === 404 && saysGone(text)) return "gone";
  throw new Error(`Attachment callback failed: ${response.status.toString()} ${text}`);
};

const saysGone = (body: string): boolean => {
  try {
    const parsed = JSON.parse(body) as { errors?: { context?: { reason?: string } }[] };
    return parsed.errors?.[0]?.context?.reason === ATTACHMENT_GONE_REASON;
  } catch {
    return false;
  }
};

export const handler = createHandler({ store, notify });
