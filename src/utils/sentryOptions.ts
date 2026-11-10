import type { NodeOptions } from "@sentry/node";
import { scrubQueryErrorEvent } from "./queryError.js";
import { createTracesSampler, parseTraceRates } from "./tracesSampler.js";

/**
 * What Sentry may collect and how it samples, shared by `instrument.ts` and
 * the test that proves no chat text, tool argument or result leaves the
 * process. Free of app imports: `instrument.ts` loads it before the app.
 */
export const sentryPrivacyAndSampling = (
  env: Record<string, string | undefined>
): Pick<
  NodeOptions,
  "dataCollection" | "beforeSend" | "tracesSampler" | "propagateTraceparent"
> => ({
  // The v10 baseline, spelled out: left unset, v11 collects request bodies (passwords on
  // sign-in), cookies and database query data.
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: {
      request: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
      response: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
    },
    httpBodies: [],
    // `code` and `state` carry OAuth authorization codes through the redirects.
    urlQueryParams: { deny: ["forwarded", "-ip", "remote-", "via", "-user", "code", "state"] },
    genAI: { inputs: false, outputs: false },
    // Tool arguments and results never leave the process (see the AI connections invariant).
    mcp: { inputs: false, outputs: false },
    databaseQueryData: false,
    queues: false,
    graphQL: { document: false, variables: false },
  },
  beforeSend: (event, hint) => scrubQueryErrorEvent(event, hint.originalException),
  tracesSampler: createTracesSampler(parseTraceRates(env)),
  // Anthropic reads only W3C `traceparent`, and the Anthropic SDK writes none here (its own
  // tracing is off, see anthropicClient.ts), so Sentry is the one source of it.
  propagateTraceparent: true,
});
