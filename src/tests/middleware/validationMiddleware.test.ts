// @ts-nocheck
/**
 * Unit tests for bodyValidationMiddleware
 * Testing library/framework: Auto-detects Jest or Vitest via globals (describe/test/expect).
 * Focus: Validate success path, error formatting, coercion, multiple issues, and non-object schemas.
 */

import { z } from "zod";
// eslint-disable-next-line import/no-unresolved
import { bodyValidationMiddleware } from "../../middleware/validationMiddleware";

const getMockFn = () => {
  if (globalThis.jest && typeof globalThis.jest.fn === "function") return globalThis.jest.fn;
  if (globalThis.vi && typeof globalThis.vi.fn === "function") return globalThis.vi.fn;
  throw new Error("No supported test framework mock function found (jest or vitest).");
};

const mockFn = getMockFn();

const createMockRes = () => {
  const res: any = {};
  res.statusCode = 200;
  res.status = mockFn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.jsonData = undefined as any;
  res.json = mockFn((data: any) => {
    res.jsonData = data;
    return res;
  });
  return res;
};

const createReq = (body: any, path = "/test") => ({ body, path } as any);

beforeEach(() => {
  if (globalThis.jest?.clearAllMocks) globalThis.jest.clearAllMocks();
  if (globalThis.vi?.clearAllMocks) globalThis.vi.clearAllMocks();
});

describe("bodyValidationMiddleware", () => {
  test("calls next() and assigns parsed data on valid payload (with coercion)", () => {
    const schema = z.object({
      name: z.string().min(1),
      age: z.coerce.number().int().min(0),
    });
    const mw = bodyValidationMiddleware(schema);
    const req = createReq({ name: "Alice", age: "42" });
    const res = createMockRes();
    const next = mockFn();

    mw(req as any, res as any, next as any);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(req.body).toEqual({ name: "Alice", age: 42 });
  });

  test("returns 422 and formatted details on invalid payload (nested paths)", () => {
    const schema = z.object({
      user: z.object({
        id: z.string().uuid(),
        email: z.string().email(),
      }),
    });
    const mw = bodyValidationMiddleware(schema);
    const req = createReq({ user: { id: "not-a-uuid" } });
    const res = createMockRes();
    const next = mockFn();

    mw(req as any, res as any, next as any);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledTimes(1);

    const payload = res.json.mock.calls[0][0];
    expect(payload).toMatchObject({ error: "Invalid data" });
    expect(Array.isArray(payload.details)).toBe(true);
    expect(payload.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/^user\.id:\s/),
        }),
        expect.objectContaining({
          message: expect.stringMatching(/^user\.email:\s/),
        }),
      ])
    );
  });

  test("uses (root) when issue.path is empty (non-object schema)", () => {
    const schema = z.string().min(3);
    const mw = bodyValidationMiddleware(schema as any);
    const req = createReq(123); // not a string
    const res = createMockRes();
    const next = mockFn();

    mw(req as any, res as any, next as any);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(422);
    const payload = res.json.mock.calls[0][0];
    expect(payload.details[0].message).toMatch(/^\(root\):\s/);
  });

  test("aggregates multiple issues", () => {
    const schema = z.object({
      a: z.string(),
      b: z.number(),
    });
    const mw = bodyValidationMiddleware(schema);
    const req = createReq({ a: 1 }); // a wrong type, b missing
    const res = createMockRes();
    const next = mockFn();

    mw(req as any, res as any, next as any);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(422);
    const details = res.json.mock.calls[0][0].details;
    expect(details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringMatching(/^a:\s/) }),
        expect.objectContaining({ message: expect.stringMatching(/^b:\s/) }),
      ])
    );
  });

  test("does not call next() on invalid payload and returns standard error envelope", () => {
    const schema = z.object({ name: z.string() });
    const mw = bodyValidationMiddleware(schema);
    const req = createReq({});
    const res = createMockRes();
    const next = mockFn();

    mw(req as any, res as any, next as any);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(422);
    const payload = res.json.mock.calls[0][0];
    expect(payload).toMatchObject({
      error: "Invalid data",
    });
    expect(Array.isArray(payload.details)).toBe(true);
  });
});