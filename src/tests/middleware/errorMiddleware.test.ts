/**
 * Tests for errorMiddleware focusing on controlled vs unhandled errors, headersSent behavior,
 * logging side-effects, and response formatting.
 *
 * Framework: Jest (ts-jest) — using jest.fn() for mocks and jest.mock for modules.
 * If the project uses Vitest, replace jest.fn/jest.mock with vi.fn/vi.mock respectively.
 */

import type { NextFunction, Request, Response } from "express";

// Infer probable import location; adjust if different in repo:
// Using relative import that mirrors source snippet structure.
import { errorMiddleware } from "../../middleware/errorMiddleware.js";

// Prefer real CustomError if available; otherwise, define a minimal local test double
// to avoid tight coupling. We will try to import first and fallback if needed.
let CustomErrorRef: any;
try {
  // Try to import as in source snippet
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  CustomErrorRef = require("../../utils/appError.js").CustomError;
} catch {
  // Minimal test double matching the fields used by middleware
  class CustomErrorDouble extends Error {
    statusCode: number;
    errors: Array<{ message: string }>;
    logging?: boolean;
    constructor(message: string, statusCode = 400, errors: Array<{ message: string }> = [{ message }], logging = false) {
      super(message);
      this.statusCode = statusCode;
      this.errors = errors;
      this.logging = logging;
    }
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  CustomErrorRef = CustomErrorDouble as any;
}

// Mock the logger module used by errorMiddleware. The snippet shows `import { logger } from "./logger.js";`
// Therefore, we mock the sibling module path relative to the middleware.
// Jest ESM interop for path mapping can be tricky; this mock path assumes same directory structure.
jest.mock("../../middleware/logger.js", () => ({
  logger: {
    error: jest.fn(),
  },
}));

// Pull the mocked logger to assert on calls
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { logger } = require("../../middleware/logger.js");

function createMockRes(): Response & {
  status: jest.Mock;
  json: jest.Mock;
  headersSent: boolean;
} {
  const res: Partial<Response> = {};
  const status = jest.fn().mockImplementation((_code: number) => res);
  const json = jest.fn().mockImplementation((_payload: unknown) => res);
  Object.assign(res, {
    status,
    json,
    headersSent: false,
  });
  return res as Response & { status: jest.Mock; json: jest.Mock; headersSent: boolean };
}

describe("errorMiddleware", () => {
  let req: Partial<Request>;
  let res: ReturnType<typeof createMockRes>;
  let next: NextFunction;

  beforeEach(() => {
    req = {} as Partial<Request>;
    res = createMockRes();
    next = jest.fn() as unknown as NextFunction;
    (logger.error as jest.Mock).mockClear();
  });

  test("delegates to next(err) if headers have already been sent", () => {
    const err = new Error("already sent");
    res.headersSent = true;

    errorMiddleware(err, req as Request, res as unknown as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  test("returns formatted client errors and status from CustomError without logging when logging=false/undefined", () => {
    const err = new CustomErrorRef("Invalid input", 422, [{ message: "Field A is required" }, { message: "Field B is invalid" }], false);

    errorMiddleware(err, req as Request, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith({
      errors: [{ message: "Field A is required" }, { message: "Field B is invalid" }],
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  test("logs controlled CustomError when logging=true and returns sanitized errors", () => {
    const err = new CustomErrorRef("Controlled", 409, [{ message: "Conflict occurred" }], true);

    errorMiddleware(err, req as Request, res as unknown as Response, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ errors: [{ message: "Conflict occurred" }] });

    expect(logger.error).toHaveBeenCalledTimes(1);
    const arg = (logger.error as jest.Mock).mock.calls[0][0];
    expect(arg).toMatchObject({
      msg: "Controlled Error",
      code: 409,
      errors: [{ message: "Conflict occurred" }],
    });
    expect(typeof arg.stack === "string" || arg.stack === undefined).toBe(true);
  });

  test("handles CustomError with empty errors array", () => {
    const err = new CustomErrorRef("No details", 400, [], false);

    errorMiddleware(err, req as Request, res as unknown as Response, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ errors: [] });
    expect(logger.error).not.toHaveBeenCalled();
  });

  test("treats non-CustomError as unhandled and returns 500 with generic message", () => {
    const err = new Error("Boom");

    errorMiddleware(err, req as Request, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ errors: [{ message: "Internal Server Error" }] });

    expect(logger.error).toHaveBeenCalledTimes(1);
    const call = (logger.error as jest.Mock).mock.calls[0][0];
    expect(call).toMatchObject({ msg: "Unhandled Error" });
    expect(call.err).toBe(err);
    expect(typeof call.stack === "string" || call.stack === undefined).toBe(true);
  });

  test("does not expose internal stack traces or extra fields in client response for CustomError", () => {
    const err = new CustomErrorRef("Detail", 418, [{ message: "I'm a teapot" }], true);
    // Attach some extra fields that must not leak
    (err as any).sensitive = "secret";

    errorMiddleware(err, req as Request, res as unknown as Response, next);

    expect(res.status).toHaveBeenCalledWith(418);
    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload).toEqual({ errors: [{ message: "I'm a teapot" }] });
    expect((payload as any).stack).toBeUndefined();
    expect((payload as any).sensitive).toBeUndefined();
  });
});