import { describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_SIGNATURE_HEADER,
  verifyAttachmentCallback,
} from "../../../services/attachment/callbackSignature.js";
import type { AttachmentProcessedPayload } from "../../../services/attachment/types.js";
import { createNotify } from "../notify.js";

const payload: AttachmentProcessedPayload = {
  attachmentId: "0f6b6a1e-6b7e-4f6c-9e0a-1d2c3b4a5f60",
  status: "READY",
  contentType: "image/jpeg",
  size: 12,
};

const reply = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status });

const errorBody = (context?: Record<string, unknown>) => ({
  errors: [{ message: "nope", ...(context ? { context } : {}) }],
});

/** An API whose answers are queued up front, remembering what it was sent. */
const fakeApi = (...answers: Response[]) => {
  const calls: { url: string; body: string; signature: string | null }[] = [];
  const fetch = vi.fn((url: URL | RequestInfo, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: url.toString(),
      body: init?.body as string,
      signature: headers.get(ATTACHMENT_SIGNATURE_HEADER),
    });
    const next = answers.shift();
    if (!next) throw new Error("no answer queued");
    return Promise.resolve(next);
  });
  return { fetch, calls };
};

const setup = (api: ReturnType<typeof fakeApi>, secrets: (string | Error)[]) => {
  const readSecret = vi.fn(() => {
    const next = secrets.shift();
    if (next === undefined) return Promise.reject(new Error("no secret queued"));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  const notify = createNotify({ apiUrl: "https://api.example.test", readSecret, fetch: api.fetch });
  return { notify, readSecret };
};

describe("attachment-processor notify", () => {
  it("posts the report signed with the secret and reads the secret once per container", async () => {
    const api = fakeApi(reply(200), reply(200));
    const { notify, readSecret } = setup(api, ["s1"]);

    await expect(notify(payload)).resolves.toEqual({ result: "applied" });
    await expect(notify(payload)).resolves.toEqual({ result: "applied" });

    expect(readSecret).toHaveBeenCalledTimes(1);
    expect(api.calls).toHaveLength(2);
    const [first] = api.calls;
    expect(first!.url).toBe("https://api.example.test/api/attachments/processed");
    expect(JSON.parse(first!.body)).toEqual(payload);
    expect(verifyAttachmentCallback("s1", first!.body, first!.signature ?? undefined)).toBe(true);
  });

  it("re-reads the secret after a refusal and sends the report once more", async () => {
    const api = fakeApi(reply(401), reply(200), reply(200));
    const { notify, readSecret } = setup(api, ["old", "new"]);

    await expect(notify(payload)).resolves.toEqual({ result: "applied" });
    await expect(notify(payload)).resolves.toEqual({ result: "applied" });

    expect(readSecret).toHaveBeenCalledTimes(2);
    const signedWith = api.calls.map((call) =>
      verifyAttachmentCallback("new", call.body, call.signature ?? undefined) ? "new" : "old"
    );
    expect(signedWith).toEqual(["old", "new", "new"]);
  });

  it("gives up after a second refusal", async () => {
    const api = fakeApi(reply(401), reply(401, errorBody()));
    const { notify } = setup(api, ["a", "b"]);

    await expect(notify(payload)).rejects.toThrow("Attachment callback failed: 401");
    expect(api.calls).toHaveLength(2);
  });

  it("does not cache a failed secret read", async () => {
    const api = fakeApi(reply(200));
    const { notify, readSecret } = setup(api, [new Error("Secrets Manager down"), "s1"]);

    await expect(notify(payload)).rejects.toThrow("Secrets Manager down");
    await expect(notify(payload)).resolves.toEqual({ result: "applied" });
    expect(readSecret).toHaveBeenCalledTimes(2);
  });

  it("reports how the row settled when the API answers 409", async () => {
    const api = fakeApi(
      reply(409, errorBody({ status: "READY", contentType: "image/jpeg" })),
      reply(409, errorBody({ status: "REJECTED", contentType: null })),
      reply(409, errorBody({ status: "DONE" })),
      reply(409, {})
    );
    const { notify } = setup(api, ["s1"]);

    await expect(notify(payload)).resolves.toEqual({
      result: "already",
      row: { status: "READY", contentType: "image/jpeg" },
    });
    await expect(notify(payload)).resolves.toEqual({
      result: "already",
      row: { status: "REJECTED", contentType: null },
    });
    await expect(notify(payload)).resolves.toEqual({ result: "already", row: undefined });
    await expect(notify(payload)).resolves.toEqual({ result: "already", row: undefined });
  });

  it("tells a deleted row from a misrouted callback", async () => {
    const api = fakeApi(
      reply(404, errorBody({ reason: "ATTACHMENT_GONE" })),
      reply(404, errorBody()),
      reply(500, errorBody())
    );
    const { notify } = setup(api, ["s1"]);

    await expect(notify(payload)).resolves.toEqual({ result: "gone" });
    await expect(notify(payload)).rejects.toThrow("Attachment callback failed: 404");
    await expect(notify(payload)).rejects.toThrow("Attachment callback failed: 500");
  });
});
