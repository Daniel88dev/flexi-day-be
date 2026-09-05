import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3ServiceException,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { ObjectStore } from "./handler.js";

const isPreconditionFailed = (error: unknown): boolean =>
  error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412;

/** The handler's bucket, as the Lambda sees it. */
export const createS3ObjectStore = (s3: S3Client, bucket: string): ObjectStore => ({
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
  // A presigned POST form stays valid for five minutes and carries no nonce,
  // so a second post to it must not replace what the first one stored: the
  // write is conditional on the key being new, and a 412 means it is not.
  put: async (key, bytes, contentType) => {
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
          IfNoneMatch: "*",
        })
      );
      return true;
    } catch (error) {
      if (isPreconditionFailed(error)) return false;
      throw error;
    }
  },
  delete: async (key) => {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  },
});
