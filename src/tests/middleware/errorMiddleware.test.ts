import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import TransportStream from "winston-transport";
import { DrizzleQueryError } from "drizzle-orm";

import { logger } from "../../middleware/logger.js";
import { errorMiddleware } from "../../middleware/errorMiddleware.js";

type Entry = Record<string, unknown>;

const captured: Entry[] = [];

class CaptureTransport extends TransportStream {
  log(info: Entry, callback: () => void) {
    captured.push(info);
    callback();
  }
}

logger.add(new CaptureTransport());

const QUERY = 'update "employment_contact" set "private_phone" = $1 where "id" = $2';

const queryError = (cause?: Error) =>
  new DrizzleQueryError(QUERY, ["+420 777 123 456", "emp_1"], cause);

const pgError = (message: string, code: string) => Object.assign(new Error(message), { code });

const respond = (err: Error) => {
  const res = {
    headersSent: false,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const req = { path: "/api/people" } as unknown as Request;
  errorMiddleware(err, req, res, vi.fn() as unknown as NextFunction);
  return res;
};

const logged = (): string => {
  const entry = captured.at(-1);
  if (!entry) throw new Error("nothing was logged");
  return JSON.stringify(entry);
};

describe("errorMiddleware with a failed query", () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it("logs the statement but none of its bound values", () => {
    const res = respond(queryError());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(captured.at(-1)).toMatchObject({
      "err.query": QUERY,
      "err.message": `Failed query: ${QUERY}`,
    });
    const entry = logged();
    expect(entry).not.toContain("+420 777 123 456");
    expect(entry).not.toContain("emp_1");
    expect(entry).not.toContain("params:");
  });

  it("keeps a constraint failure's cause, which names identifiers only", () => {
    respond(
      queryError(
        pgError('duplicate key value violates unique constraint "employment_number_key"', "23505")
      )
    );

    expect(captured.at(-1)).toMatchObject({
      "err.cause": 'duplicate key value violates unique constraint "employment_number_key"',
    });
  });

  it("redacts the input a data exception quotes back in its cause", () => {
    respond(queryError(pgError('invalid input syntax for type uuid: "+420 777 123 456"', "22P02")));

    const entry = logged();
    expect(entry).not.toContain("+420 777 123 456");
    expect(captured.at(-1)).toMatchObject({
      "err.cause": 'invalid input syntax for type uuid: "[redacted]"',
    });
  });
});

describe("logger with a failed query outside a request", () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it("drops the bound values from an error a job logs", () => {
    logger.error("Retention purge failed", { error: queryError() });

    expect(captured.at(-1)).toMatchObject({ "error.query": QUERY });
    expect(logged()).not.toContain("+420 777 123 456");
  });
});
