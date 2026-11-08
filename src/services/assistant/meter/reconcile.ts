import { parseArgs } from "node:util";
import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../db/db.js";
import { assistantModelCalls } from "../../../db/schema/assistant-meter-schema.js";
import { logger } from "../../../middleware/logger.js";
import { usedAmount } from "./meter.js";

/** Drift is tolerated up to the larger of these. */
const DRIFT_RATIO = 0.02;
const DRIFT_FLOOR_MICRO_USD = 1_000_000;
const STALE_RESERVATION_MS = 15 * 60_000;
const MICRO_USD_PER_CENT = 10_000;

const USAGE = `Usage: pnpm run assistant:reconcile --month <YYYY-MM> --report <file> [--workspace <id>]

<file> is the JSON of GET /v1/organizations/cost_report with group_by[]=workspace_id and
group_by[]=description, one page or an array of pages.`;

const costResult = z.object({
  amount: z.string(),
  currency: z.string(),
  cost_type: z.string().nullable(),
  model: z.string().nullable().optional(),
  workspace_id: z.string().nullable().optional(),
});
const costPage = z.object({
  data: z.array(
    z.object({ starting_at: z.string(), ending_at: z.string(), results: z.array(costResult) })
  ),
});
const costReport = z.union([costPage, z.array(costPage)]);

const DEFAULT_WORKSPACE = "default";

type ReportLine = { workspaceId: string; model: string; microUsd: number };

/** The month's token costs per workspace and model; runtime and tools are outside the meter. */
const reportLines = (json: unknown, from: Date, until: Date): ReportLine[] => {
  const pages = [costReport.parse(json)].flat();
  const lines: ReportLine[] = [];
  for (const bucket of pages.flatMap((page) => page.data)) {
    const startsAt = new Date(bucket.starting_at);
    if (startsAt < from || startsAt >= until) continue;
    for (const result of bucket.results) {
      if (result.cost_type === null) {
        throw new Error(
          "The report is not grouped by description; fetch it with group_by[]=description"
        );
      }
      if (result.cost_type !== "tokens") continue;
      if (result.currency !== "USD") throw new Error(`Unexpected currency ${result.currency}`);
      lines.push({
        workspaceId: result.workspace_id ?? DEFAULT_WORKSPACE,
        model: result.model ?? "unknown",
        microUsd: Math.round(Number(result.amount) * MICRO_USD_PER_CENT),
      });
    }
  }
  return lines;
};

const dollars = (microUsd: number) => `$${(microUsd / 1_000_000).toFixed(4)}`;

const monthBounds = (month: string) => {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const index = Number(match[2]) - 1;
  return {
    from: new Date(Date.UTC(year, index, 1)),
    until: new Date(Date.UTC(year, index + 1, 1)),
  };
};

const sumBy = <T>(items: T[], key: (item: T) => string, amount: (item: T) => number) => {
  const sums = new Map<string, number>();
  for (const item of items) sums.set(key(item), (sums.get(key(item)) ?? 0) + amount(item));
  return sums;
};

/**
 * `pnpm run assistant:reconcile`: sums the ledger's Usage for a UTC month per
 * model, compares it with the workspace's token cost in Anthropic's cost
 * report, logs `assistant.reconcile_drift` above the tolerance, and lists
 * reservations older than 15 minutes. Answers the exit code: 0 within
 * tolerance, 1 on drift, 2 on bad input.
 */
export const runReconcile = async (
  argv: string[],
  io: { readFile: (file: string) => Promise<string>; print: (line: string) => void },
  now = new Date()
): Promise<number> => {
  let values: { month?: string; report?: string; workspace?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        month: { type: "string" },
        report: { type: "string" },
        workspace: { type: "string" },
      },
    }));
  } catch {
    io.print(USAGE);
    return 2;
  }
  const bounds = values.month ? monthBounds(values.month) : null;
  if (!values.month || !bounds || !values.report) {
    io.print(USAGE);
    return 2;
  }
  const month = values.month;

  let lines: ReportLine[];
  try {
    lines = reportLines(JSON.parse(await io.readFile(values.report)), bounds.from, bounds.until);
  } catch (error) {
    io.print(
      `Could not read the report: ${error instanceof Error ? error.message : String(error)}`
    );
    return 2;
  }

  const workspaces = [...new Set(lines.map((line) => line.workspaceId))].sort();
  const workspaceId = values.workspace ?? (workspaces.length === 1 ? workspaces[0] : undefined);
  if (!workspaceId) {
    io.print(
      `The report holds ${workspaces.length === 0 ? "no token cost" : workspaces.join(", ")}` +
        " for the month; name the deployment's workspace with --workspace."
    );
    return 2;
  }
  const report = sumBy(
    lines.filter((line) => line.workspaceId === workspaceId),
    (line) => line.model,
    (line) => line.microUsd
  );

  const inMonth = and(
    gte(assistantModelCalls.createdAt, bounds.from),
    lt(assistantModelCalls.createdAt, bounds.until)
  );
  const ledgerRows = await db
    .select({
      model: assistantModelCalls.modelId,
      used: sql<number>`coalesce(sum(${usedAmount}), 0)::float8`.mapWith(Number),
    })
    .from(assistantModelCalls)
    .where(inMonth)
    .groupBy(assistantModelCalls.modelId);
  const ledger = new Map(ledgerRows.map((row) => [row.model, row.used]));
  const stale = await db
    .select({
      id: assistantModelCalls.id,
      organizationId: assistantModelCalls.organizationId,
      sessionId: assistantModelCalls.sessionId,
      reservedMicroUsd: assistantModelCalls.reservedMicroUsd,
      createdAt: assistantModelCalls.createdAt,
    })
    .from(assistantModelCalls)
    .where(
      and(
        inMonth,
        eq(assistantModelCalls.status, "reserved"),
        lt(assistantModelCalls.createdAt, new Date(now.getTime() - STALE_RESERVATION_MS))
      )
    )
    .orderBy(asc(assistantModelCalls.createdAt));

  const total = (sums: Map<string, number>) => [...sums.values()].reduce((a, b) => a + b, 0);
  const ledgerMicroUsd = total(ledger);
  const reportMicroUsd = total(report);
  const driftMicroUsd = Math.abs(ledgerMicroUsd - reportMicroUsd);
  const tolerance = Math.max(DRIFT_FLOOR_MICRO_USD, reportMicroUsd * DRIFT_RATIO);
  const percent = reportMicroUsd === 0 ? null : (driftMicroUsd / reportMicroUsd) * 100;

  io.print(`Reconcile ${month}, workspace ${workspaceId}`);
  const models = [...new Set([...ledger.keys(), ...report.keys()])].sort();
  const width = Math.max(5, ...models.map((model) => model.length)) + 2;
  io.print(`${"Model".padEnd(width)}${"Ledger".padEnd(14)}Anthropic`);
  for (const model of models) {
    io.print(
      `${model.padEnd(width)}${dollars(ledger.get(model) ?? 0).padEnd(14)}${dollars(report.get(model) ?? 0)}`
    );
  }
  io.print(
    `Ledger ${dollars(ledgerMicroUsd)}, Anthropic ${dollars(reportMicroUsd)}, ` +
      `drift ${dollars(driftMicroUsd)}${percent === null ? "" : ` (${percent.toFixed(2)}%)`}, ` +
      `tolerance ${dollars(tolerance)}.`
  );
  io.print(`Reservations older than 15 minutes: ${stale.length === 0 ? "none" : stale.length}`);
  for (const row of stale) {
    io.print(
      `  ${row.id}  ${row.createdAt.toISOString()}  ${dollars(row.reservedMicroUsd)}  ` +
        `organization ${row.organizationId}  session ${row.sessionId ?? "-"}`
    );
  }

  if (driftMicroUsd <= tolerance) return 0;
  logger.error("assistant.reconcile_drift", {
    month,
    workspaceId,
    ledgerMicroUsd,
    reportMicroUsd,
    driftMicroUsd,
    staleReservations: stale.length,
  });
  return 1;
};
