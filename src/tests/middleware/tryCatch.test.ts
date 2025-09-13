/**
 * Tests for tryCatch middleware wrapper.
 *
 * Framework: The project’s detected test runner will be used.
 * - If Vitest is configured, we import { describe, it, expect, vi } from 'vitest'.
 * - If Jest is configured, globals describe/it/expect/jest are used, and vi falls back to jest.
 *
 * These tests focus on:
 *  - Happy path: callback resolves; next is not called with error.
 *  - Sync throw: callback throws immediately; next called with the error.
 *  - Async reject: callback returns rejected promise; next called with the error.
 *  - Callback calls next() without error: wrapper should forward normally and not add errors.
 *  - Callback calls next(err): wrapper should pass same error once (no double-call).
 *  - Ensures callback is awaited (order assertions).
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";

// Try to import vitest utilities; fall back to jest globals if unavailable.
// This pattern allows running in either Vitest or Jest without additional deps.
let viLike: any;
let spyOnLike: any;
let fnLike: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const v = require("vitest");
  viLike = v.vi;
  spyOnLike = v.spyOn;
  fnLike = v.vi.fn;
  // Re-export vitest's describe/it/expect when available
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const g = require("vitest");
  // @ts-ignore
  global.describe = g.describe;
  // @ts-ignore
  global.it = g.it;
  // @ts-ignore
  global.expect = g.expect;
} catch {
  // Jest fallback: use global jest
  // @ts-ignore
  viLike = global.jest ?? {};
  // @ts-ignore
  spyOnLike = (obj: any, method: any) => global.jest.spyOn(obj, method);
  // @ts-ignore
  fnLike = (...args: any[]) => global.jest.fn<any, any[]>(...args);
}

import { tryCatch } from "../../middleware/tryCatch"; // Adjusted relative to this test file

// Minimal mock objects for Express Request/Response/NextFunction
const createReq = (): Partial<Request> => ({});
const createRes = (): Partial<Response> => ({
  // add fields if a future test needs them
});

const createNext = () =>
  fnLike((err?: any) => {
    if (err) {
      // In real Express, next(err) would delegate to error handler.
    }
  }) as unknown as NextFunction;

describe("tryCatch middleware", () => {
  it("calls the callback with (req, res, next) and awaits it on success (happy path)", async () => {
    const req = createReq() as Request;
    const res = createRes() as Response;
    const next = createNext();

    const order: string[] = [];
    const callback: RequestHandler = fnLike(async (_req, _res, _next) => {
      order.push("callback-start");
      await Promise.resolve();
      order.push("callback-end");
    });

    const wrapped = tryCatch(callback);
    order.push("before-call");
    await wrapped(req, res, next);
    order.push("after-call");

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(req, res, next);
    expect(next).toHaveBeenCalledTimes(0);
    expect(order).toEqual(["before-call", "callback-start", "callback-end", "after-call"]);
  });

  it("forwards synchronous thrown errors to next(err)", async () => {
    const req = createReq() as Request;
    const res = createRes() as Response;
    const next = createNext();

    const thrown = new Error("sync boom");
    const callback: RequestHandler = fnLike((_req, _res, _next) => {
      throw thrown;
    });

    const wrapped = tryCatch(callback);
    await wrapped(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const [errArg] = (next as unknown as jest.Mock | typeof fnLike).mock.calls[0] || [];
    expect(errArg).toBe(thrown);
  });

  it("forwards rejected promise errors to next(err)", async () => {
    const req = createReq() as Request;
    const res = createRes() as Response;
    const next = createNext();

    const rejected = new Error("async boom");
    const callback: RequestHandler = fnLike(async () => {
      return Promise.reject(rejected);
    });

    const wrapped = tryCatch(callback);
    await wrapped(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const [errArg] = (next as unknown as jest.Mock | typeof fnLike).mock.calls[0] || [];
    expect(errArg).toBe(rejected);
  });

  it("supports callbacks that call next() without error (no extra error forwarding)", async () => {
    const req = createReq() as Request;
    const res = createRes() as Response;
    const next = createNext();

    const callback: RequestHandler = fnLike((_req, _res, nextFn) => {
      nextFn(); // normal progression
    });

    const wrapped = tryCatch(callback);
    await wrapped(req, res, next);

    // One call from the callback, none added by the wrapper
    expect(next).toHaveBeenCalledTimes(1);
    const callArgs = (next as unknown as jest.Mock | typeof fnLike).mock.calls[0] || [];
    expect(callArgs.length === 0 || callArgs[0] === undefined).toBe(true);
  });

  it("does not double-call next when callback calls next(err) explicitly", async () => {
    const req = createReq() as Request;
    const res = createRes() as Response;
    const next = createNext();

    const err = new Error("explicit error via next");
    const callback: RequestHandler = fnLike((_req, _res, nextFn) => {
      nextFn(err);
    });

    const wrapped = tryCatch(callback);
    await wrapped(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const [errArg] = (next as unknown as jest.Mock | typeof fnLike).mock.calls[0] || [];
    expect(errArg).toBe(err);
  });

  it("awaits async callbacks that resolve after a delay", async () => {
    const req = createReq() as Request;
    const res = createRes() as Response;
    const next = createNext();

    const callback: RequestHandler = fnLike(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const wrapped = tryCatch(callback);
    await wrapped(req, res, next);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });
});