import { describe, it, expect } from "vitest";
import request from "supertest";
// @ts-ignore
import { createServer } from "../server";

describe("Health endpoint", () => {
  it("GET /health returns 200", async () => {
    const res = await request(createServer()).get("/health");
    expect(res.status).toBe(200);
  });
});
