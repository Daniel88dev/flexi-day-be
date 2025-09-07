/* 
Note: This test suite uses the project's existing test runner.
- If using Vitest: import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
- If using Jest:  import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals"
We conditionally adapt based on availability at runtime by attempting Vitest first.
Testing library/framework: Prefer Vitest if available; otherwise Jest.
*/

let usingVitest = false;
try {
  // @ts-ignore - in environments without vitest types
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('vitest');
  usingVitest = true;
} catch (_e) {
  usingVitest = false;
}

type TempEmailType = {
  to: string;
  subject: string;
  text: string;
};

const importTestTools = () => {
  if (usingVitest) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const v = require('vitest');
    return {
      describe: v.describe,
      it: v.it,
      expect: v.expect,
      beforeEach: v.beforeEach,
      afterEach: v.afterEach,
      mocker: v.vi,
      fakeTimers: () => {
        v.vi.useFakeTimers();
        return {
          advanceBy: (ms: number) => v.vi.advanceTimersByTime(ms),
          runAll: () => v.vi.runAllTimers(),
          clear: () => v.vi.clearAllTimers(),
          restore: () => v.vi.useRealTimers(),
        };
      },
    };
  } else {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const j = require('@jest/globals');
    return {
      describe: j.describe,
      it: j.it,
      expect: j.expect,
      beforeEach: j.beforeEach,
      afterEach: j.afterEach,
      mocker: j.jest,
      fakeTimers: () => {
        j.jest.useFakeTimers();
        return {
          advanceBy: (ms: number) => j.jest.advanceTimersByTime(ms),
          runAll: () => j.jest.runAllTimers(),
          clear: () => j.jest.clearAllTimers(),
          restore: () => j.jest.useRealTimers(),
        };
      },
    };
  }
};

const { describe, it, expect, beforeEach, afterEach, mocker, fakeTimers } = importTestTools();

/**
 * We mock the logger module used by the implementation:
 * import { logger } from "../middleware/logger.js";
 *
 * The tests assert that logger.info is called once with:
 *   ("tempEmail.send", { to, subject, bodyPreviewChars })
 */
const LOGGER_PATH = "../middleware/logger.js";

// Provide a stable mock shape no matter the runner
const infoSpy = mocker.fn();
const debugSpy = mocker.fn();
const errorSpy = mocker.fn();

mocker.mock(LOGGER_PATH, () => {
  return {
    logger: {
      info: infoSpy,
      debug: debugSpy,
      error: errorSpy,
    },
  };
});

// Now import the unit under test after the mock is in place.
const { tempEmailSend } = require("../tempEmail" in require ? "../tempEmail" : "./tempEmail.test"); // Fallback if pathing differs

describe("tempEmailSend", () => {
  let timers: ReturnType<typeof fakeTimers>;

  beforeEach(() => {
    infoSpy.mockReset();
    debugSpy.mockReset();
    errorSpy.mockReset();
    timers = fakeTimers();
  });

  afterEach(() => {
    timers.clear();
    timers.restore();
  });

  it("logs expected metadata for short text (happy path)", async () => {
    const payload: TempEmailType = {
      to: "user@example.com",
      subject: "Hello",
      text: "Short body",
    };

    const p = tempEmailSend(payload);
    timers.advanceBy(25);
    await p;

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [message, meta] = infoSpy.mock.calls[0];
    expect(message).toBe("tempEmail.send");
    expect(meta).toMatchObject({
      to: "user@example.com",
      subject: "Hello",
    });
    expect(meta.bodyPreviewChars).toBe(payload.text.length);
  });

  it("caps bodyPreviewChars at 100 for long text", async () => {
    const longText = "x".repeat(250);
    const payload: TempEmailType = {
      to: "long@example.com",
      subject: "Long",
      text: longText,
    };

    const p = tempEmailSend(payload);
    timers.advanceBy(25);
    await p;

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [, meta] = infoSpy.mock.calls[0];
    expect(meta.bodyPreviewChars).toBe(100);
  });

  it("handles empty strings and logs 0 preview chars", async () => {
    const payload: TempEmailType = {
      to: "",
      subject: "",
      text: "",
    };

    const p = tempEmailSend(payload);
    timers.advanceBy(25);
    await p;

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [, meta] = infoSpy.mock.calls[0];
    expect(meta).toMatchObject({ to: "", subject: "" });
    expect(meta.bodyPreviewChars).toBe(0);
  });

  it("waits at least 25ms before resolving", async () => {
    const payload: TempEmailType = {
      to: "timing@example.com",
      subject: "Timing",
      text: "Check timing",
    };

    const promise = tempEmailSend(payload);

    // Before advancing timers, it should not have logged
    expect(infoSpy).toHaveBeenCalledTimes(0);

    // Advance less than 25ms; should still not resolve
    timers.advanceBy(20);
    // No call yet
    expect(infoSpy).toHaveBeenCalledTimes(0);

    // Advance remaining time
    timers.advanceBy(5);
    await promise;

    expect(infoSpy).toHaveBeenCalledTimes(1);
  });

  it("throws when provided invalid input (defensive behavior)", async () => {
    const invalid: any = undefined;

    const call = async () => {
      const p = tempEmailSend(invalid);
      timers.advanceBy(25);
      await p;
    };

    await expect(call()).rejects.toThrow();
    expect(infoSpy).toHaveBeenCalledTimes(0);
  });
});