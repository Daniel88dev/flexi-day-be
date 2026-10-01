import { describe, it, expect, onTestFinished } from "vitest";
import request from "supertest";
// @ts-ignore
import { createServer } from "../server";
import { listenOnLoopback } from "./loopbackServer.js";

describe("Health endpoint", () => {
  it("GET /health returns 200", async () => {
    const { url, close } = await listenOnLoopback(createServer());
    onTestFinished(close);
    const res = await request(url).get("/health");
    expect(res.status).toBe(200);
  });
});
