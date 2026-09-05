import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import {
  ATTACHMENT_SIGNATURE_HEADER,
  signAttachmentCallback,
} from "../../services/attachment/callbackSignature.js";
import type { AttachmentProcessedPayload } from "../../services/attachment/types.js";
import { createHandler, type NotifyResult, type ObjectStore } from "./handler.js";

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

const s3 = new S3Client({});

const store: ObjectStore = {
  get: async (key) => {
    try {
      const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!object.Body) return undefined;
      return {
        bytes: Buffer.from(await object.Body.transformToByteArray()),
        contentType: object.ContentType,
        metadata: object.Metadata ?? {},
      };
    } catch (error) {
      if (error instanceof NoSuchKey) return undefined;
      throw error;
    }
  },
  put: async (key, bytes, contentType) => {
    await s3.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType })
    );
  },
  delete: async (key) => {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  },
};

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
  // 409: an earlier delivery already moved the row. 404: the row was deleted
  // while the bytes were in flight, so the handler drops what it wrote.
  if (response.ok || response.status === 409) return "settled";
  if (response.status === 404) return "gone";
  throw new Error(
    `Attachment callback failed: ${response.status.toString()} ${await response.text()}`
  );
};

export const handler = createHandler({ store, notify });
