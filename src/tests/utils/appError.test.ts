// Auto-generated tests for AppError
// Detected test framework: vitest
import { describe, it, expect } from "vitest";
import AppError, { CustomError } from '../../utils/appError';

describe("AppError", () => {
  it("constructs with defaults (message, statusCode, logging, context, errors)", () => {
    const err = new AppError();

    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(CustomError);
    expect(err).toBeInstanceOf(Error);

    expect(err.statusCode).toBe(400);
    expect(err.logging).toBe(false);
    expect(err.message).toBe("Bad Request");
    expect(err.errors).toEqual([{ message: "Bad Request", context: {} }]);

    expect(typeof err.stack).toBe("string");
  });

  it("uses provided code, message, logging, context, and cause", () => {
    const cause = new Error("root cause");
    const ctx = { field: "name", detail: "Required" };
    const err = new AppError({ code: 422, message: "Invalid input", logging: true, context: ctx, cause });

    expect(err.statusCode).toBe(422);
    expect(err.logging).toBe(true);
    expect(err.message).toBe("Invalid input");
    expect((err as any).cause).toBe(cause);
    expect(err.errors).toEqual([{ message: "Invalid input", context: ctx }]);
  });

  it('falls back to default message when provided an empty string', () => {
    const err = new AppError({ message: "" });
    expect(err.message).toBe("Bad Request");
    expect(err.errors[0].message).toBe("Bad Request");
  });

  it("respects a code of 0 via nullish coalescing", () => {
    const err = new AppError({ code: 0 });
    expect(err.statusCode).toBe(0);
    expect(err.logging).toBe(false);
    expect(err.errors).toEqual([{ message: "Bad Request", context: {} }]);
  });

  it("exposes dynamic message in errors getter (reflects message changes)", () => {
    const err = new AppError({ message: "Initial" });
    err.message = "Changed later";
    expect(err.errors[0].message).toBe("Changed later");
  });

  it("preserves prototype chain", () => {
    const err = new AppError();
    expect(Object.getPrototypeOf(err)).toBe((AppError as any).prototype);
  });

  it("accepts non-Error causes", () => {
    const raw = { reason: "non-error cause" };
    const err = new AppError({ cause: raw as any });
    expect((err as any).cause).toBe(raw);
  });

  it("returns provided context object by reference in errors", () => {
    const ctx: Record<string, unknown> = {};
    const err = new AppError({ context: ctx });
    const entry = err.errors[0];

    // The errors getter returns the same context object reference
    expect(entry.context).toBe(ctx);

    // Mutations reflect across calls because the same object is referenced
    (entry.context as any)["newKey"] = 123;
    expect(err.errors[0].context).toHaveProperty("newKey", 123);
  });
});