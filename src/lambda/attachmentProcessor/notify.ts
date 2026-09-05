import {
  ATTACHMENT_SIGNATURE_HEADER,
  signAttachmentCallback,
} from "../../services/attachment/callbackSignature.js";
import {
  ATTACHMENT_GONE_REASON,
  type AttachmentProcessedPayload,
} from "../../services/attachment/types.js";
import type { NotifyResult, SettledRow } from "./handler.js";

export type NotifyDeps = {
  apiUrl: string;
  /** Fetches the callback secret; called once per container, and again after a refusal. */
  readSecret: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
};

/**
 * Delivers a report to the API, signed with the callback secret. The secret
 * is cached for the life of the container; a 401 drops the cache and sends
 * the report once more, so a rotated secret reaches a warm Lambda through
 * the refusal rather than only through its next cold start.
 */
export const createNotify = ({ apiUrl, readSecret, fetch = globalThis.fetch }: NotifyDeps) => {
  let secret: Promise<string> | undefined;
  // A failed read is not cached, so the next report retries it.
  const getSecret = () =>
    (secret ??= readSecret().catch((error: unknown) => {
      secret = undefined;
      throw error;
    }));

  const post = async (body: string) =>
    fetch(new URL("/api/attachments/processed", apiUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [ATTACHMENT_SIGNATURE_HEADER]: signAttachmentCallback(await getSecret(), body),
      },
      body,
    });

  return async (payload: AttachmentProcessedPayload): Promise<NotifyResult> => {
    const body = JSON.stringify(payload);
    let response = await post(body);
    if (response.status === 401) {
      secret = undefined;
      response = await post(body);
    }
    if (response.ok) return { result: "applied" };
    // 409: an earlier delivery already moved the row. 404 with the API's own
    // reason: the row was deleted while the bytes were in flight. Any other
    // 404 is a misrouted callback, which must not cost the upload.
    const text = await response.text();
    const context = errorContext(text);
    if (response.status === 409) return { result: "already", row: settledRow(context) };
    if (response.status === 404 && context?.reason === ATTACHMENT_GONE_REASON) {
      return { result: "gone" };
    }
    throw new Error(`Attachment callback failed: ${response.status.toString()} ${text}`);
  };
};

type ErrorContext = Record<string, unknown> | undefined;

const errorContext = (body: string): ErrorContext => {
  try {
    const parsed = JSON.parse(body) as { errors?: { context?: ErrorContext }[] };
    return parsed.errors?.[0]?.context;
  } catch {
    return undefined;
  }
};

const settledRow = (context: ErrorContext): SettledRow | undefined => {
  const status = context?.status;
  const contentType = context?.contentType ?? null;
  if (status !== "READY" && status !== "REJECTED") return undefined;
  if (contentType !== null && typeof contentType !== "string") return undefined;
  return { status, contentType };
};
