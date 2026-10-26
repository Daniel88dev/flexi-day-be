import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../../config.js";
import { contentDisposition } from "../attachment/contentDisposition.js";
import { incomingKey } from "../attachment/s3Layout.js";
import { UPLOAD_URL_TTL_MS, type UploadTarget } from "../attachment/types.js";

export type SignedDownload = { url: string; expiresAt: string };

/**
 * S3 object metadata the presigned photo POST pins, so the Lambda learns
 * which photo an object is and where its two sizes go without a database.
 */
export const PHOTO_UPLOAD_METADATA = { photoId: "photo-id", storageKey: "storage-key" } as const;

/** An image link is signed at the start of its hour, so it stays the same all hour. */
export const IMAGE_URL_WINDOW_MS = 60 * 60 * 1000;
/** Two windows, so a link handed out late in its hour still works for one more. */
export const IMAGE_URL_TTL_MS = 2 * IMAGE_URL_WINDOW_MS;

const imageWindowStart = (now = Date.now()) =>
  Math.floor(now / IMAGE_URL_WINDOW_MS) * IMAGE_URL_WINDOW_MS;

/** Where organization data lives: the organization-data bucket, or disk without one. */
export interface OrganizationDataStore {
  putFile: (key: string, filePath: string, contentType: string) => Promise<void>;
  putObject: (key: string, bytes: Buffer, contentType: string) => Promise<void>;
  getObject: (key: string) => Promise<Buffer | undefined>;
  deleteObject: (key: string) => Promise<void>;
  /** Deletes every object whose key starts with `prefix`, which must end in `/`. */
  deletePrefix: (prefix: string) => Promise<void>;
  createDownloadUrl: (input: {
    key: string;
    fileName: string;
    contentType: string;
    ttlMs: number;
  }) => Promise<SignedDownload>;
  /** Where the browser sends a Profile photo's bytes: `incoming/<photoId>` on S3. */
  createPhotoUploadTarget: (input: {
    photoId: string;
    contentType: string;
    size: number;
    storageKey: string;
  }) => Promise<UploadTarget>;
  /** A link to show an image, the same for the hour it was signed in (see {@link IMAGE_URL_TTL_MS}). */
  createImageUrl: (key: string) => Promise<string>;
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

const sameSignature = (expected: string, signature: string) => {
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** True when `signature` was issued for exactly this download and it has not expired. */
export const verifyLocalDownload = (input: SignedLocalDownload, signature: string): boolean => {
  if (!Number.isFinite(input.expires) || input.expires < Date.now()) return false;
  return sameSignature(sign(input), signature);
};

const signParts = (parts: string[]) =>
  createHmac("sha256", signingKey).update(parts.join("\n")).digest("hex");

export type SignedLocalPhotoUpload = { photoId: string; expires: number };
export type SignedLocalImage = { key: string; expires: number };

const photoUploadParts = (input: SignedLocalPhotoUpload) => [
  "organization-data-photo-upload",
  input.photoId,
  input.expires.toString(),
];
const imageParts = (input: SignedLocalImage) => [
  "organization-data-image",
  input.key,
  input.expires.toString(),
];

const verifyParts = (expires: number, parts: string[], signature: string) =>
  Number.isFinite(expires) && expires >= Date.now() && sameSignature(signParts(parts), signature);

export const verifyLocalPhotoUpload = (input: SignedLocalPhotoUpload, signature: string) =>
  verifyParts(input.expires, photoUploadParts(input), signature);

export const verifyLocalImage = (input: SignedLocalImage, signature: string) =>
  verifyParts(input.expires, imageParts(input), signature);

const apiBaseUrl = config.auth?.url ?? `http://localhost:${config.api.port.toString()}`;

const keyToPath = (root: string, key: string): string => {
  const resolved = path.resolve(root, key);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) {
    throw new Error(`Organization data key escapes the store root: ${key}`);
  }
  return resolved;
};

const assertPrefix = (prefix: string): string => {
  if (!/^[^/]+\/.*\/$/.test(prefix)) throw new Error(`Not a folder prefix: ${prefix}`);
  return prefix;
};

/** The development stand-in: files on disk, downloaded through the API's own signed route. */
export const createDiskOrganizationDataStore = (root: string): OrganizationDataStore => ({
  putFile: async (key, filePath) => {
    const file = keyToPath(root, key);
    await mkdir(path.dirname(file), { recursive: true });
    await copyFile(filePath, file);
  },
  putObject: async (key, bytes) => {
    const file = keyToPath(root, key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
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
  deletePrefix: async (prefix) => {
    await rm(keyToPath(root, assertPrefix(prefix)), { recursive: true, force: true });
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
  createPhotoUploadTarget: ({ photoId, contentType }) => {
    const signed = { photoId, expires: Date.now() + UPLOAD_URL_TTL_MS };
    const url = new URL(`/api/organization-data/local/photos/${photoId}`, apiBaseUrl);
    url.searchParams.set("expires", signed.expires.toString());
    url.searchParams.set("signature", signParts(photoUploadParts(signed)));
    return Promise.resolve({
      url: url.toString(),
      method: "PUT",
      headers: { "Content-Type": contentType },
      expiresAt: new Date(signed.expires).toISOString(),
    });
  },
  createImageUrl: (key) => {
    const signed = { key, expires: imageWindowStart() + IMAGE_URL_TTL_MS };
    const url = new URL("/api/organization-data/local/image", apiBaseUrl);
    url.searchParams.set("key", key);
    url.searchParams.set("expires", signed.expires.toString());
    url.searchParams.set("signature", signParts(imageParts(signed)));
    return Promise.resolve(url.toString());
  },
});

/** The production store. Objects take the bucket's default SSE-KMS key. */
export const createS3OrganizationDataStore = (options: {
  bucket: string;
  region: string;
  credentials?: S3ClientConfig["credentials"];
}): OrganizationDataStore => {
  const { bucket } = options;
  const client = new S3Client({ region: options.region, credentials: options.credentials });

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
    putObject: async (key, bytes, contentType) => {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType })
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
    // Versioning keeps the old versions behind a delete marker until the
    // bucket's 7-day noncurrent rule removes them.
    deletePrefix: async (prefix) => {
      let continuationToken: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: assertPrefix(prefix),
            ContinuationToken: continuationToken,
          })
        );
        const keys = (page.Contents ?? []).flatMap((object) =>
          object.Key ? [{ Key: object.Key }] : []
        );
        if (keys.length > 0) {
          const result = await client.send(
            new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } })
          );
          if (result.Errors?.length) {
            throw new Error(`Could not delete ${result.Errors.length.toString()} objects`);
          }
        }
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (continuationToken);
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
    createPhotoUploadTarget: async ({ photoId, contentType, size, storageKey }) => {
      const expires = Date.now() + UPLOAD_URL_TTL_MS;
      const { url, fields } = await createPresignedPost(client, {
        Bucket: bucket,
        Key: incomingKey(photoId),
        Conditions: [["content-length-range", 1, size]],
        Fields: {
          "Content-Type": contentType,
          [`x-amz-meta-${PHOTO_UPLOAD_METADATA.photoId}`]: photoId,
          [`x-amz-meta-${PHOTO_UPLOAD_METADATA.storageKey}`]: storageKey,
        },
        Expires: UPLOAD_URL_TTL_MS / 1000,
      });
      return { url, method: "POST", fields, expiresAt: new Date(expires).toISOString() };
    },
    // The signing date is pinned to the hour, so every response in that hour
    // hands out the same URL and the browser and the phone can cache the image.
    createImageUrl: (key) =>
      getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ResponseContentType: "image/jpeg",
          ResponseCacheControl: `private, max-age=${(IMAGE_URL_WINDOW_MS / 1000).toString()}`,
        }),
        { expiresIn: IMAGE_URL_TTL_MS / 1000, signingDate: new Date(imageWindowStart()) }
      ),
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
