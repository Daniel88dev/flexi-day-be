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
});
