import { S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createHandler, routeByBucket } from "./handler.js";
import { createNotify } from "./notify.js";
import { createPhotoHandler } from "./photoHandler.js";
import { createS3ObjectStore } from "./s3ObjectStore.js";
import type { PhotoProcessedPayload } from "../../services/directory/types.js";

/**
 * The Lambda entry point. Bundled by `lambda/attachment-processor/build.mjs`
 * together with the shared processor; nothing here may import the API's
 * config, database or store.
 */

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
};

const bucket = env("ATTACHMENTS_BUCKET");
const apiUrl = env("API_URL");
const callbackSecretArn = env("ATTACHMENTS_CALLBACK_SECRET_ARN");

const s3 = new S3Client({});
const store = createS3ObjectStore(s3, bucket);
const secrets = new SecretsManagerClient({});

const readSecret = async (): Promise<string> => {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: callbackSecretArn }));
  if (!secret.SecretString) throw new Error("Attachment callback secret is empty");
  return secret.SecretString;
};

// The organization-data bucket's name comes from its event, so the function
// needs no setting of its own for the second trigger.
const notifyPhoto = createNotify<PhotoProcessedPayload>({
  apiUrl,
  readSecret,
  path: "/api/directory/photos/processed",
  goneReason: "PHOTO_GONE",
  callback: "Photo",
});

export const handler = routeByBucket({
  attachmentsBucket: bucket,
  attachments: createHandler({ store, notify: createNotify({ apiUrl, readSecret }) }),
  photos: (photoBucket) =>
    createPhotoHandler({ store: createS3ObjectStore(s3, photoBucket), notify: notifyPhoto }),
});
