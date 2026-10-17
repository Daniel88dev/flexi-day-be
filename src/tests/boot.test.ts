import { describe, it, expect, vi } from "vitest";

const { checkMock } = vi.hoisted(() => ({ checkMock: vi.fn(() => Promise.resolve()) }));

vi.mock("http", () => ({
  default: {
    createServer: () => ({
      listen: (_port: number, onListening: () => void) => onListening(),
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
vi.mock("../jobs/authSecretCheckJob.js", () => ({ runAuthSecretCheck: checkMock }));

describe("boot", () => {
  it("runs the auth secret check once the server listens", async () => {
    await import("../index.js");

    expect(checkMock).toHaveBeenCalledTimes(1);
  });
});
