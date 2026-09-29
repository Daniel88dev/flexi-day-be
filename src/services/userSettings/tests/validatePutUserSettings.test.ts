import { describe, it, expect } from "vitest";
import { validatePutUserSettings } from "../types.js";

describe("validatePutUserSettings", () => {
  it.each(["LANES", "STRIPES"])("accepts %s as the dashboard calendar view", (view) => {
    expect(validatePutUserSettings.parse({ dashboardCalendarView: view })).toEqual({
      dashboardCalendarView: view,
    });
  });

  it.each(["TIMELINE", "lanes", "", null, 1])(
    "rejects %j as the dashboard calendar view",
    (view) => {
      const result = validatePutUserSettings.safeParse({ dashboardCalendarView: view });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain(
        "dashboardCalendarView"
      );
    }
  );

  it("accepts a group id that is not a UUID", () => {
    const groupId = "Kq7Rz2mWb9XfT4nLp8VdC3sHy6JgA1eE";
    expect(validatePutUserSettings.parse({ dashboardGroupId: groupId })).toEqual({
      dashboardGroupId: groupId,
    });
  });

  it("strips keys that are not settings, such as the row's user id and timestamps", () => {
    expect(
      validatePutUserSettings.parse({
        emailNotifications: false,
        userId: "someone_else",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })
    ).toStrictEqual({ emailNotifications: false });
  });

  it("rejects a body that carries only keys that are not settings", () => {
    const result = validatePutUserSettings.safeParse({
      userId: "someone_else",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toContain(
      "At least one setting must be supplied"
    );
  });
});
