import { describe, it, expect, vi } from "vitest";

const { steps, checkMock } = vi.hoisted(() => {
  const steps: string[] = [];
  return {
    steps,
    checkMock: vi.fn(async () => {
      steps.push("check started");
      await new Promise((resolve) => setTimeout(resolve, 20));
      steps.push("check finished");
    }),
  };
});

vi.mock("http", () => ({
  default: {
    createServer: () => ({
      listen: (_port: number, onListening: () => void) => {
        steps.push("listen");
        onListening();
      },
      on: vi.fn(),
    }),
  },
}));
vi.mock("../server.js", () => ({ createServer: vi.fn() }));
vi.mock("../config.js", () => ({ config: { api: { port: 8080 } } }));
vi.mock("../middleware/logger.js", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock("../jobs/quotaRolloverJob.js", () => ({
  startQuotaRolloverJob: vi.fn(),
  stopQuotaRolloverJob: vi.fn(),
}));
vi.mock("../jobs/calendarSyncQueueJob.js", () => ({
  startCalendarSyncQueue: vi.fn(() => Promise.resolve()),
  stopCalendarSyncQueue: vi.fn(),
}));
vi.mock("../jobs/personExportQueueJob.js", () => ({
  startPersonExportQueue: vi.fn(() => Promise.resolve()),
  stopPersonExportQueue: vi.fn(),
}));
vi.mock("../jobs/authSecretCheckJob.js", () => ({ runAuthSecretCheck: checkMock }));

describe("boot", () => {
  it("finishes the auth secret check before the server listens", async () => {
    await import("../index.js");

    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(steps).toEqual(["check started", "check finished", "listen"]);
  });
});
