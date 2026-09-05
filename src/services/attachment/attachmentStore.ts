import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../../config.js";
import { createS3AttachmentStore } from "./s3AttachmentStore.js";
import {
  DOWNLOAD_URL_TTL_MS,
  UPLOAD_URL_TTL_MS,
  type AttachmentDisposition,
  type AttachmentStore,
} from "./types.js";

export type SignedLocalUrl = {
  attachmentId: string;
  purpose: "upload" | "download";
  expires: number;
  disposition?: AttachmentDisposition;
};

// The session secret is absent under test; a per-process key is enough there.
const signingKey = config.auth?.secret ?? randomBytes(32).toString("hex");

const payloadOf = (input: SignedLocalUrl) =>
  [input.purpose, input.attachmentId, input.expires.toString(), input.disposition ?? ""].join(":");

const sign = (input: SignedLocalUrl) =>
  createHmac("sha256", signingKey).update(payloadOf(input)).digest("hex");

/** True when `signature` was issued for exactly this URL and it has not expired. */
export const verifyLocalSignature = (input: SignedLocalUrl, signature: string): boolean => {
  if (!Number.isFinite(input.expires) || input.expires < Date.now()) return false;
  const expected = Buffer.from(sign(input));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
};

const apiBaseUrl = config.auth?.url ?? `http://localhost:${config.api.port.toString()}`;

const localUrl = (input: SignedLocalUrl): string => {
  const url = new URL(`/api/attachments/local/${input.purpose}/${input.attachmentId}`, apiBaseUrl);
  url.searchParams.set("expires", input.expires.toString());
  if (input.disposition) url.searchParams.set("disposition", input.disposition);
  url.searchParams.set("signature", sign(input));
  return url.toString();
};

const keyToPath = (root: string, key: string): string => {
  // A key is server-generated, but the check costs nothing and closes the door
  // on a future caller passing a `..` segment through.
  const resolved = path.resolve(root, key);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) {
    throw new Error(`Attachment key escapes the store root: ${key}`);
  }
  return resolved;
};

/** The development stand-in: bytes on local disk, served by the API's own signed routes. */
export const createDiskAttachmentStore = (root: string): AttachmentStore => ({
  createUploadTarget: ({ attachmentId, contentType }) => {
    const expires = Date.now() + UPLOAD_URL_TTL_MS;
    return Promise.resolve({
      url: localUrl({ purpose: "upload", attachmentId, expires }),
      method: "PUT",
      headers: { "Content-Type": contentType },
      expiresAt: new Date(expires).toISOString(),
    });
  },
  createDownloadUrl: ({ attachmentId, disposition }) => {
    const expires = Date.now() + DOWNLOAD_URL_TTL_MS;
    return Promise.resolve({
      url: localUrl({ purpose: "download", attachmentId, expires, disposition }),
      expiresAt: new Date(expires).toISOString(),
    });
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
});

/** Disk unless a bucket is configured; the local routes exist only in that mode. */
export const isDiskAttachmentStore = config.attachments.bucket === undefined;

export const attachmentStore: AttachmentStore = config.attachments.bucket
  ? createS3AttachmentStore({
      bucket: config.attachments.bucket,
      region: config.attachments.region,
    })
  : createDiskAttachmentStore(config.attachments.localDir);
