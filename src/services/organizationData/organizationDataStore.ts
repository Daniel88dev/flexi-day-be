import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../../config.js";
import { contentDisposition } from "../attachment/contentDisposition.js";

export type SignedDownload = { url: string; expiresAt: string };

/** Where organization data lives: the organization-data bucket, or disk without one. */
export interface OrganizationDataStore {
  putFile: (key: string, filePath: string, contentType: string) => Promise<void>;
  getObject: (key: string) => Promise<Buffer | undefined>;
  deleteObject: (key: string) => Promise<void>;
  createDownloadUrl: (input: {
    key: string;
    fileName: string;
    contentType: string;
    ttlMs: number;
  }) => Promise<SignedDownload>;
}

export type SignedLocalDownload = {
  key: string;
  fileName: string;
  contentType: string;
  expires: number;
};

const signingKey = config.auth?.secret ?? randomBytes(32).toString("hex");

const sign = (input: SignedLocalDownload) =>
  createHmac("sha256", signingKey)
    .update(
      ["organization-data", input.key, input.fileName, input.contentType, input.expires].join("\n")
    )
    .digest("hex");

/** True when `signature` was issued for exactly this download and it has not expired. */
export const verifyLocalDownload = (input: SignedLocalDownload, signature: string): boolean => {
  if (!Number.isFinite(input.expires) || input.expires < Date.now()) return false;
  const expected = Buffer.from(sign(input));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
};

const apiBaseUrl = config.auth?.url ?? `http://localhost:${config.api.port.toString()}`;

const keyToPath = (root: string, key: string): string => {
  const resolved = path.resolve(root, key);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) {
    throw new Error(`Organization data key escapes the store root: ${key}`);
  }
  return resolved;
};

/** The development stand-in: files on disk, downloaded through the API's own signed route. */
export const createDiskOrganizationDataStore = (root: string): OrganizationDataStore => ({
  putFile: async (key, filePath) => {
    const file = keyToPath(root, key);
    await mkdir(path.dirname(file), { recursive: true });
    await copyFile(filePath, file);
  },
  getObject: async (key) => {
    try {
      return await readFile(keyToPath(root, key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  },
  deleteObject: async (key) => {
    await rm(keyToPath(root, key), { force: true });
  },
  createDownloadUrl: ({ key, fileName, contentType, ttlMs }) => {
    const signed = { key, fileName, contentType, expires: Date.now() + ttlMs };
    const url = new URL("/api/organization-data/local", apiBaseUrl);
    url.searchParams.set("key", key);
    url.searchParams.set("name", fileName);
    url.searchParams.set("type", contentType);
    url.searchParams.set("expires", signed.expires.toString());
    url.searchParams.set("signature", sign(signed));
    return Promise.resolve({
      url: url.toString(),
      expiresAt: new Date(signed.expires).toISOString(),
    });
  },
});

/** The production store. Objects take the bucket's default SSE-KMS key. */
export const createS3OrganizationDataStore = (options: {
  bucket: string;
  region: string;
}): OrganizationDataStore => {
  const { bucket } = options;
  const client = new S3Client({ region: options.region });

  return {
    putFile: async (key, filePath, contentType) => {
      const { size } = await stat(filePath);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: createReadStream(filePath),
          ContentLength: size,
          ContentType: contentType,
        })
      );
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
    createDownloadUrl: async ({ key, fileName, contentType, ttlMs }) => {
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ResponseContentDisposition: contentDisposition("attachment", fileName),
          ResponseContentType: contentType,
        }),
        { expiresIn: Math.floor(ttlMs / 1000) }
      );
      return { url, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
    },
  };
};

/** Disk unless a bucket is configured; the local download route exists only in that mode. */
export const isDiskOrganizationDataStore =
  config.organizationData.bucket === undefined && config.api.env !== "production";

/**
 * Undefined in production until the bucket is configured, so personal data
 * never lands on App Runner's own disk.
 */
export const organizationDataStore: OrganizationDataStore | undefined = config.organizationData
  .bucket
  ? createS3OrganizationDataStore({
      bucket: config.organizationData.bucket,
      region: config.organizationData.region,
    })
  : config.api.env === "production"
    ? undefined
    : createDiskOrganizationDataStore(config.organizationData.localDir);
