import { S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createHandler } from "./handler.js";
import { createNotify } from "./notify.js";
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
const secrets = new SecretsManagerClient({});

const readSecret = async (): Promise<string> => {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: callbackSecretArn }));
  if (!secret.SecretString) throw new Error("Attachment callback secret is empty");
  return secret.SecretString;
};

export const handler = createHandler({ store, notify: createNotify({ apiUrl, readSecret }) });
