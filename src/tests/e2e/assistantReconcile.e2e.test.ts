import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db } from "../../db/db.js";
import { assistantModelCalls } from "../../db/schema/assistant-meter-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { logger } from "../../middleware/logger.js";
import { runReconcile } from "../../services/assistant/meter/reconcile.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { createWebUser } from "./helpers/authHelper.js";
import { makeGroup, resetReportData } from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "anthropicCostReport-2026-10.json"
);

describe("pnpm run assistant:reconcile", () => {
  let organizationId: string;
  let printed: string[];
  const io = {
    readFile: (file: string) => readFile(file, "utf8"),
    print: (line: string) => printed.push(line),
  };

  const ledgerRow = async (
    microUsd: number,
    createdAt: Date,
    options: { model?: string; status?: "settled" | "reserved" } = {}
  ) => {
    const id = generateRandomUUID();
    const status = options.status ?? "settled";
    await db.insert(assistantModelCalls).values({
      id,
      organizationId,
      userId: null,
      sessionId: `sesn_${id.slice(0, 8)}`,
      purpose: "main",
      modelId: options.model ?? "claude-sonnet-5-5",
      priceVersion: "test",
      status,
      reservedMicroUsd: microUsd,
      settledMicroUsd: status === "settled" ? microUsd : null,
      weekStart: createdAt.toISOString().slice(0, 10),
      createdAt,
    });
    return id;
  };

  beforeAll(async () => {
    await cleanupTestData();
    await resetReportData();
    const owner = await createWebUser("Olga Owner");
    await makeGroup("Team", owner.id, { organizationOwnerId: owner.id });
    const [organization] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.ownerUserId, owner.id));
    organizationId = organization!.id;
  });

  beforeEach(async () => {
    printed = [];
    await db.delete(assistantModelCalls);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await db.delete(assistantModelCalls);
    await cleanupTestData();
    await resetReportData();
  });

  it("finds the month within tolerance and says so", async () => {
    await ledgerRow(12_400_000, new Date("2026-10-01T10:00:00Z"));
    await ledgerRow(495_000, new Date("2026-10-31T23:00:00Z"), { model: "claude-haiku-5-5" });
    await ledgerRow(5_000_000, new Date("2026-09-30T12:00:00Z"));
    await ledgerRow(5_000_000, new Date("2026-11-01T00:00:00Z"));
    const error = vi.spyOn(logger, "error");

    const code = await runReconcile(
      ["--month", "2026-10", "--report", FIXTURE, "--workspace", "wrkspc_prod"],
      io
    );

    expect(code).toBe(0);
    expect(error).not.toHaveBeenCalled();
    const output = printed.join("\n");
    expect(output).toContain("Ledger $12.8950, Anthropic $13.0000, drift $0.1050 (0.81%)");
    expect(output).toMatch(/claude-sonnet-5-5\s+\$12\.4000\s+\$12\.5050/);
    expect(output).toMatch(/claude-haiku-5-5\s+\$0\.4950\s+\$0\.4950/);
    expect(output).toContain("Reservations older than 15 minutes: none");
  });

  it("logs an error on drift above the tolerance and lists stale reservations", async () => {
    await ledgerRow(12_400_000, new Date("2026-10-01T10:00:00Z"));
    await ledgerRow(495_000, new Date("2026-10-31T23:00:00Z"), { model: "claude-haiku-5-5" });
    const stale = await ledgerRow(2_000_000, new Date("2026-10-20T08:30:00Z"), {
      status: "reserved",
    });
    const error = vi.spyOn(logger, "error");

    const code = await runReconcile(
      ["--month", "2026-10", "--report", FIXTURE, "--workspace", "wrkspc_prod"],
      io
    );

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "assistant.reconcile_drift",
      expect.objectContaining({
        month: "2026-10",
        workspaceId: "wrkspc_prod",
        ledgerMicroUsd: 14_895_000,
        reportMicroUsd: 13_000_000,
        driftMicroUsd: 1_895_000,
        staleReservations: 1,
      })
    );
    const output = printed.join("\n");
    expect(output).toContain("drift $1.8950 (14.58%)");
    expect(output).toContain("Reservations older than 15 minutes: 1");
    expect(output).toContain(stale);
    expect(output).toContain("2026-10-20T08:30:00.000Z");
  });

  it("lists only reservations older than 15 minutes in the current month", async () => {
    const now = new Date("2026-11-20T12:00:00Z");
    const old = await ledgerRow(300_000, new Date(now.getTime() - 20 * 60_000), {
      status: "reserved",
    });
    const fresh = await ledgerRow(300_000, new Date(now.getTime() - 5 * 60_000), {
      status: "reserved",
    });

    await runReconcile(
      ["--month", "2026-11", "--report", FIXTURE, "--workspace", "wrkspc_prod"],
      io,
      now
    );

    const output = printed.join("\n");
    expect(output).toContain("Reservations older than 15 minutes: 1");
    expect(output).toContain(old);
    expect(output).not.toContain(fresh);
  });

  it("asks for the workspace when the report holds several", async () => {
    const code = await runReconcile(["--month", "2026-10", "--report", FIXTURE], io);

    expect(code).toBe(2);
    expect(printed.join("\n")).toContain("wrkspc_dev, wrkspc_prod");
  });
});
