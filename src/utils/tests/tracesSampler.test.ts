import { describe, it, expect } from "vitest";
import { createTracesSampler, parseTraceRates } from "../tracesSampler.js";

const RATES = parseTraceRates({
  SENTRY_TRACES_SAMPLE_RATE: "0.2",
  SENTRY_TRACES_MCP_RATE: "0.05",
  SENTRY_TRACES_ASSISTANT_RATE: "0.7",
});
const sample = createTracesSampler(RATES);

/** A server span as the SDK hands it over: the name is the method, the path is `url.path`. */
const request = (method: string, path: string, parentSampled?: boolean) => ({
  name: method,
  attributes: { "sentry.op": "http.server", "url.path": path },
  parentSampled,
  inheritOrSampleWith: (fallback: number) =>
    parentSampled === undefined ? fallback : parentSampled ? 1 : 0,
});

describe("tracesSampler", () => {
  it("never samples the health probe", () => {
    expect(sample(request("GET", "/health"))).toBe(0);
    expect(sample(request("GET", "/health", true))).toBe(0);
  });

  it("samples /mcp at its own rate whatever the caller's trace says", () => {
    expect(sample(request("POST", "/mcp"))).toBe(0.05);
    expect(sample(request("POST", "/mcp", true))).toBe(0.05);
    expect(sample(request("POST", "/mcp", false))).toBe(0.05);
  });

  it("samples the Assistant's routes and its webhook at the Assistant rate, ignoring the parent", () => {
    expect(sample(request("POST", "/api/assistant/chats/abc/messages", false))).toBe(0.7);
    expect(sample(request("GET", "/api/assistant/organizations", true))).toBe(0.7);
    expect(sample(request("POST", "/api/webhooks/anthropic"))).toBe(0.7);
  });

  it("samples OAuth and discovery at the default rate, ignoring the parent", () => {
    expect(sample(request("POST", "/api/auth/oauth2/token", true))).toBe(0.2);
    expect(sample(request("GET", "/.well-known/oauth-protected-resource/mcp", true))).toBe(0.2);
  });

  it("lets the signing keys follow the /mcp call that fetched them", () => {
    expect(sample(request("GET", "/api/auth/jwks", false))).toBe(0);
    expect(sample(request("GET", "/api/auth/jwks", true))).toBe(1);
  });

  it("lets every other route inherit the parent, or sample at the default rate", () => {
    expect(sample(request("GET", "/api/vacation", true))).toBe(1);
    expect(sample(request("GET", "/api/vacation", false))).toBe(0);
    expect(sample(request("GET", "/api/vacation"))).toBe(0.2);
  });

  it("treats a span with no path, such as a background job, as any other route", () => {
    expect(
      sample({ name: "GET 127.0.0.1", attributes: {}, inheritOrSampleWith: (fallback) => fallback })
    ).toBe(0.2);
  });

  it("does not take a longer path that only starts like a sampled one", () => {
    expect(sample(request("GET", "/mcpx"))).toBe(0.2);
    expect(sample(request("GET", "/api/assistantx"))).toBe(0.2);
    expect(sample(request("GET", "/healthz"))).toBe(0.2);
  });
});

describe("parseTraceRates", () => {
  it("defaults to 0.2, 0.05 and 1", () => {
    expect(parseTraceRates({})).toEqual({ default: 0.2, mcp: 0.05, assistant: 1 });
  });

  it.each(["", "abc", "-0.1", "1.5", "NaN"])("refuses %j as a rate", (value) => {
    expect(() => parseTraceRates({ SENTRY_TRACES_MCP_RATE: value })).toThrow(
      "SENTRY_TRACES_MCP_RATE must be a number from 0 to 1"
    );
  });
});
