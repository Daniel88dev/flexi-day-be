import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  timeline,
  mockOverdueBreaks,
  mockOverdueSessions,
  mockCloseBreak,
  mockCloseSession,
  mockNotifySessionAutoClosed,
} = vi.hoisted(() => ({
  timeline: [] as string[],
  mockOverdueBreaks: vi.fn(),
  mockOverdueSessions: vi.fn(),
  mockCloseBreak: vi.fn(),
  mockCloseSession: vi.fn(),
  mockNotifySessionAutoClosed: vi.fn(),
}));

vi.mock("../attendanceCeilingCloses.js", () => ({
  overdueBreaks: mockOverdueBreaks,
  overdueSessions: mockOverdueSessions,
  closeBreak: mockCloseBreak,
  closeSession: mockCloseSession,
}));

vi.mock("../attendanceNotifier.js", () => ({
  notifySessionAutoClosed: mockNotifySessionAutoClosed,
}));

vi.mock("../../../middleware/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { sweepAttendanceCeilings } from "../attendanceCeilings.js";

const NOW = new Date("2026-09-26T00:00:00Z");

const overdueSession = (id: string, userId: string, businessDate = "2026-09-25") => ({
  id,
  employmentId: `employment-of-${userId}`,
  userId,
  businessDate,
  timezone: "Europe/Prague",
  closeAt: new Date(`${businessDate}T16:30:00Z`),
});

const overdueBreak = (id: string, userId: string) => ({
  id,
  employmentId: `employment-of-${userId}`,
  closeAt: new Date("2026-09-25T11:30:00Z"),
});

describe("sweepAttendanceCeilings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    timeline.length = 0;
    mockOverdueBreaks.mockResolvedValue([]);
    mockOverdueSessions.mockResolvedValue([]);
    mockCloseBreak.mockImplementation(async (row: { id: string }) => {
      timeline.push(`close break ${row.id}`);
      return true;
    });
    mockCloseSession.mockImplementation(async (row: { id: string }) => {
      timeline.push(`close session ${row.id}`);
      return true;
    });
    mockNotifySessionAutoClosed.mockImplementation(async (session: { id: string }) => {
      timeline.push(`notify ${session.id}`);
    });
  });

  it("tells the owner of a closed session once, after its close commits", async () => {
    mockOverdueSessions.mockResolvedValue([overdueSession("s1", "user-1")]);

    expect(await sweepAttendanceCeilings(NOW)).toEqual({ sessions: 1, breaks: 0 });

    expect(mockNotifySessionAutoClosed).toHaveBeenCalledTimes(1);
    expect(mockNotifySessionAutoClosed).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "s1",
        userId: "user-1",
        businessDate: "2026-09-25",
        timezone: "Europe/Prague",
        closeAt: new Date("2026-09-25T16:30:00Z"),
      })
    );
    expect(timeline).toEqual(["close session s1", "notify s1"]);
  });

  it("covers a break auto-closed inside the session with the session's one notice", async () => {
    mockOverdueBreaks.mockResolvedValue([overdueBreak("b1", "user-1")]);
    mockOverdueSessions.mockResolvedValue([overdueSession("s1", "user-1")]);

    expect(await sweepAttendanceCeilings(NOW)).toEqual({ sessions: 1, breaks: 1 });

    expect(mockNotifySessionAutoClosed).toHaveBeenCalledTimes(1);
    expect(timeline).toEqual(["close break b1", "close session s1", "notify s1"]);
  });

  it("sends nothing for a break closed inside a session still running", async () => {
    mockOverdueBreaks.mockResolvedValue([overdueBreak("b1", "user-1")]);

    expect(await sweepAttendanceCeilings(NOW)).toEqual({ sessions: 0, breaks: 1 });

    expect(mockNotifySessionAutoClosed).not.toHaveBeenCalled();
  });

  it("tells each owner about their own session when several close in one sweep", async () => {
    mockOverdueSessions.mockResolvedValue([
      overdueSession("s1", "user-1", "2026-09-25"),
      overdueSession("s2", "user-2", "2026-09-24"),
    ]);

    expect(await sweepAttendanceCeilings(NOW)).toEqual({ sessions: 2, breaks: 0 });

    expect(timeline).toEqual(["close session s1", "close session s2", "notify s1", "notify s2"]);
    expect(mockNotifySessionAutoClosed).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s2", userId: "user-2", businessDate: "2026-09-24" })
    );
  });

  it("says nothing about a session somebody closed before the sweep got to it", async () => {
    mockOverdueSessions.mockResolvedValue([overdueSession("s1", "user-1")]);
    mockCloseSession.mockResolvedValue(false);

    expect(await sweepAttendanceCeilings(NOW)).toEqual({ sessions: 0, breaks: 0 });

    expect(mockNotifySessionAutoClosed).not.toHaveBeenCalled();
  });

  it("says nothing about a close that failed, and carries on with the rest", async () => {
    mockOverdueSessions.mockResolvedValue([
      overdueSession("s1", "user-1"),
      overdueSession("s2", "user-2"),
    ]);
    mockCloseSession.mockImplementationOnce(async () => {
      throw new Error("deadlock");
    });

    expect(await sweepAttendanceCeilings(NOW)).toEqual({ sessions: 1, breaks: 0 });

    expect(timeline).toEqual(["close session s2", "notify s2"]);
  });
});
