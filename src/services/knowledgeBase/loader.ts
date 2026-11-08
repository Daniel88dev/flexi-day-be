import { kbBundleSchema, type KbBundle } from "./types.js";

export type KnowledgeBaseLoader = {
  /** The bundle as last loaded, without fetching. */
  current(): KbBundle | null;
  /**
   * The bundle for a use: loads it when none was loaded yet (once per retry
   * window while that keeps failing), and revalidates a stale copy in the
   * background. `null` while no bundle was ever loaded.
   */
  get(): Promise<KbBundle | null>;
  /** One conditional GET now; never throws. Concurrent calls share one request. */
  refresh(): Promise<void>;
  /** Resolves when no request is in flight. */
  settled(): Promise<void>;
};

export type KnowledgeBaseLoaderOptions = {
  url: () => string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** How old a copy may be before a use revalidates it. */
  refreshMs: number;
  /** While no bundle was ever loaded, how long after a failed attempt a use tries again. */
  retryMs: number;
  /** Each bundle with a new ETag or version, the first one included. */
  onBundle?: (bundle: KbBundle) => void | Promise<void>;
  /** A failed attempt while no bundle was ever loaded. */
  onUnavailable?: (error: unknown) => void;
  /** A failed refresh while the last good copy keeps serving. */
  onStale?: (error: unknown) => void;
};

class BundleFetchError extends Error {
  constructor(reason: string) {
    super(`Knowledge-base bundle not loaded: ${reason}`);
    this.name = "BundleFetchError";
  }
}

/**
 * Loads `/help/kb.json`: on first use, then by ETag. A failed or malformed
 * refresh keeps the last good copy.
 */
export const createKnowledgeBaseLoader = (
  options: KnowledgeBaseLoaderOptions
): KnowledgeBaseLoader => {
  const now = options.now ?? Date.now;
  let bundle: KbBundle | null = null;
  let etag: string | null = null;
  let checkedAt = 0;
  let failedAt: number | null = null;
  let inflight: Promise<void> | null = null;

  const attempt = async () => {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const response = await fetchImpl(options.url(), {
      headers: {
        Accept: "application/json",
        ...(bundle && etag ? { "If-None-Match": etag } : {}),
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 304 && bundle) return;
    if (!response.ok) throw new BundleFetchError(`HTTP ${response.status.toString()}`);
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new BundleFetchError("not JSON");
    }
    const parsed = kbBundleSchema.safeParse(json);
    if (!parsed.success) throw new BundleFetchError("not a bundle");
    const nextEtag = response.headers.get("etag");
    const isNew = !bundle || bundle.version !== parsed.data.version || etag !== nextEtag;
    bundle = parsed.data;
    etag = nextEtag;
    if (isNew) await options.onBundle?.(parsed.data);
  };

  const refresh = (): Promise<void> => {
    inflight ??= (async () => {
      try {
        await attempt();
        failedAt = null;
      } catch (error) {
        failedAt = now();
        if (bundle) options.onStale?.(error);
        else options.onUnavailable?.(error);
      } finally {
        checkedAt = now();
        inflight = null;
      }
    })();
    return inflight;
  };

  return {
    current: () => bundle,
    get: async () => {
      if (!bundle) {
        if (failedAt === null || now() - failedAt > options.retryMs) await refresh();
        else if (inflight) await inflight;
        return bundle;
      }
      if (now() - checkedAt > options.refreshMs) void refresh();
      return bundle;
    },
    refresh,
    settled: async () => {
      if (inflight) await inflight;
    },
  };
};
