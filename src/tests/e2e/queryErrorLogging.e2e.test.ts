import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import TransportStream from "winston-transport";
import { sql } from "drizzle-orm";
import { db } from "../../db/db.js";
import { logger } from "../../middleware/logger.js";
import { errorMiddleware } from "../../middleware/errorMiddleware.js";
import { tryCatch } from "../../middleware/tryCatch.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";

type Entry = Record<string, unknown>;

const captured: Entry[] = [];

class CaptureTransport extends TransportStream {
  log(info: Entry, callback: () => void) {
    captured.push(info);
    callback();
  }
}

const VALUE = "ada.lovelace+private@example.com";

describe("a failed query reaching errorMiddleware", () => {
  let server: LoopbackServer;
  const transport = new CaptureTransport();

  beforeAll(async () => {
    logger.add(transport);
    const app = express();
    app.get(
      "/missing-column",
      tryCatch(async () => {
        await db.execute(sql`select "no_such_column" from "user" where "email" = ${VALUE}`);
      })
    );
    app.get(
      "/bad-input",
      tryCatch(async () => {
        await db.execute(sql`select ${VALUE}::uuid`);
      })
    );
    app.use(errorMiddleware);
    server = await listenOnLoopback(app);
  });

  afterAll(async () => {
    logger.remove(transport);
    await server?.close();
  });

  beforeEach(() => {
    captured.length = 0;
  });

  const unhandled = (): Entry => {
    const entry = captured.find((e) => e.message === "Unhandled Error");
    if (!entry) throw new Error("errorMiddleware logged nothing");
    return entry;
  };

  it("logs the statement and the Postgres error without the bound value", async () => {
    const res = await request(server.url).get("/missing-column");

    expect(res.status).toBe(500);
    const entry = unhandled();
    expect(entry["err.message"]).toBe(
      'Failed query: select "no_such_column" from "user" where "email" = $1'
    );
    expect(entry["err.cause"]).toBe('column "no_such_column" does not exist');
    expect(JSON.stringify(entry)).not.toContain(VALUE);
  });

  it("drops the value Postgres quotes back in a data exception", async () => {
    const res = await request(server.url).get("/bad-input");

    expect(res.status).toBe(500);
    const entry = unhandled();
    expect(entry["err.cause"]).toBe('invalid input syntax for type uuid: "[redacted]"');
    expect(JSON.stringify(entry)).not.toContain(VALUE);
  });
});
