import { describe, expect, it } from "vitest";
import { kbSnapshot } from "../../../tests/fixtures/kbSnapshot.js";
import type { KbBundle } from "../types.js";
import { createKnowledgeBaseLoader } from "../loader.js";

const URL = "http://kb.test/help/kb.json";
const MINUTE = 60_000;

type Reply = { status: number; etag?: string; body?: unknown } | Error;

/** A scripted `fetch`: answers in order and records the headers of each request. */
const scriptedFetch = (replies: Reply[]) => {
  const requests: { url: string; ifNoneMatch: string | null }[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      ifNoneMatch: new Headers(init?.headers).get("If-None-Match"),
    });
    const reply = replies.shift();
    if (!reply) return Promise.reject(new Error("no scripted reply left"));
    if (reply instanceof Error) return Promise.reject(reply);
    const headers = new Headers(reply.etag ? { ETag: reply.etag } : {});
    const body =
      reply.status === 304 || reply.body === undefined
        ? null
        : typeof reply.body === "string"
          ? reply.body
          : JSON.stringify(reply.body);
    return Promise.resolve(new Response(body, { status: reply.status, headers }));
  };
  return { fetch, requests };
};

const bundle = kbSnapshot();
const changed: KbBundle = { ...bundle, version: "changed00001" };

const setup = (replies: Reply[]) => {
  let clock = 0;
  const scripted = scriptedFetch(replies);
  const handedOver: KbBundle[] = [];
  const failures: unknown[] = [];
  const loader = createKnowledgeBaseLoader({
    url: () => URL,
    fetch: scripted.fetch,
    now: () => clock,
    refreshMs: 5 * MINUTE,
    retryMs: 30_000,
    onBundle: (next) => {
      handedOver.push(next);
    },
    onUnavailable: (error) => {
      failures.push(error);
    },
  });
  return {
    loader,
    requests: scripted.requests,
    handedOver,
    failures,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

describe("the knowledge-base loader", () => {
  it("fetches on first use and hands the bundle over once", async () => {
    const kb = setup([{ status: 200, etag: '"v1"', body: bundle }]);

    expect(kb.loader.current()).toBeNull();
    const loaded = await kb.loader.get();

    expect(loaded?.version).toBe(bundle.version);
    expect(kb.requests).toEqual([{ url: URL, ifNoneMatch: null }]);
    expect(kb.handedOver.map((b) => b.version)).toEqual([bundle.version]);
    await kb.loader.get();
    expect(kb.requests).toHaveLength(1);
  });

  it("revalidates with If-None-Match once the copy is five minutes old and keeps it on 304", async () => {
    const kb = setup([
      { status: 200, etag: '"v1"', body: bundle },
      { status: 304, etag: '"v1"' },
    ]);
    await kb.loader.get();

    kb.advance(5 * MINUTE + 1);
    await kb.loader.refresh();

    expect(kb.requests[1]).toEqual({ url: URL, ifNoneMatch: '"v1"' });
    expect(kb.loader.current()?.version).toBe(bundle.version);
    expect(kb.handedOver).toHaveLength(1);
  });

  it("keeps the last good bundle when a refresh fails or answers something that isn't a bundle", async () => {
    const kb = setup([
      { status: 200, etag: '"v1"', body: bundle },
      new Error("connect ECONNREFUSED"),
      { status: 500, body: "oops" },
      { status: 200, etag: '"v2"', body: "<html>not json</html>" },
      { status: 200, etag: '"v3"', body: { version: "x" } },
    ]);
    await kb.loader.get();

    for (let attempt = 0; attempt < 4; attempt++) {
      kb.advance(5 * MINUTE + 1);
      await kb.loader.refresh();
      expect(kb.loader.current()?.version).toBe(bundle.version);
    }
    expect(kb.requests.slice(1).every((r) => r.ifNoneMatch === '"v1"')).toBe(true);
    expect(kb.handedOver).toHaveLength(1);
    expect(kb.failures).toHaveLength(0);
  });

  it("hands over a new bundle when the ETag changes", async () => {
    const kb = setup([
      { status: 200, etag: '"v1"', body: bundle },
      { status: 200, etag: '"v2"', body: changed },
    ]);
    await kb.loader.get();
    kb.advance(5 * MINUTE + 1);
    await kb.loader.refresh();

    expect(kb.loader.current()?.version).toBe("changed00001");
    expect(kb.handedOver.map((b) => b.version)).toEqual([bundle.version, "changed00001"]);
  });

  it("serves the current copy at once and revalidates a stale one in the background", async () => {
    const kb = setup([
      { status: 200, etag: '"v1"', body: bundle },
      { status: 200, etag: '"v2"', body: changed },
    ]);
    await kb.loader.get();
    kb.advance(5 * MINUTE + 1);

    expect((await kb.loader.get())?.version).toBe(bundle.version);
    await kb.loader.settled();
    expect(kb.loader.current()?.version).toBe("changed00001");
  });

  it("reports when no bundle was ever loaded and retries at most every 30 seconds", async () => {
    const kb = setup([new Error("connect ECONNREFUSED"), { status: 200, body: bundle }]);

    expect(await kb.loader.get()).toBeNull();
    expect(kb.failures).toHaveLength(1);
    expect(await kb.loader.get()).toBeNull();
    expect(kb.requests).toHaveLength(1);

    kb.advance(30_001);
    expect((await kb.loader.get())?.version).toBe(bundle.version);
    expect(kb.requests).toHaveLength(2);
  });
});
