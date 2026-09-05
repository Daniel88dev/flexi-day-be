import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { contentDisposition } from "./contentDisposition.js";
import { incomingKey, UPLOAD_METADATA } from "./s3Layout.js";
import { DOWNLOAD_URL_TTL_MS, UPLOAD_URL_TTL_MS, type AttachmentStore } from "./types.js";

const metadataField = (name: string) => `x-amz-meta-${name}`;

/** The production store: presigned POST to `incoming/`, presigned GET for a minute. */
export const createS3AttachmentStore = (options: {
  bucket: string;
  region: string;
  credentials?: S3ClientConfig["credentials"];
}): AttachmentStore => {
  const { bucket } = options;
  const client = new S3Client({ region: options.region, credentials: options.credentials });

  return {
    createUploadTarget: async ({ attachmentId, contentType, size, storageKey }) => {
      const expires = Date.now() + UPLOAD_URL_TTL_MS;
      const { url, fields } = await createPresignedPost(client, {
        Bucket: bucket,
        Key: incomingKey(attachmentId),
        Conditions: [["content-length-range", 1, size]],
        Fields: {
          "Content-Type": contentType,
          [metadataField(UPLOAD_METADATA.attachmentId)]: attachmentId,
          [metadataField(UPLOAD_METADATA.storageKey)]: storageKey,
        },
        Expires: UPLOAD_URL_TTL_MS / 1000,
      });
      return { url, method: "POST", fields, expiresAt: new Date(expires).toISOString() };
    },
    createDownloadUrl: async ({ storageKey, fileName, contentType, disposition }) => {
      const expires = Date.now() + DOWNLOAD_URL_TTL_MS;
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: storageKey,
          ResponseContentDisposition: contentDisposition(disposition, fileName),
          ResponseContentType: contentType,
        }),
        { expiresIn: DOWNLOAD_URL_TTL_MS / 1000 }
      );
      return { url, expiresAt: new Date(expires).toISOString() };
    },
    putObject: async (key, bytes) => {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes }));
    },
    getObject: async (key) => {
      try {
        const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return object.Body ? Buffer.from(await object.Body.transformToByteArray()) : undefined;
      } catch (error) {
        if (error instanceof NoSuchKey) return undefined;
        throw error;
      }
    },
    deleteObject: async (key) => {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
};
