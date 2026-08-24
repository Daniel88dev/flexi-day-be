import type { Request, Response } from "express";
import { z } from "zod";
import AppError from "../../utils/appError.js";
import { buildIcsCalendar, type IcsEvent } from "../../utils/ics.js";
import { VACATION_TYPE_LABELS } from "./utils.js";
import {
  getCalendarSyncByToken,
  getFeedRecords,
  touchLastFetched,
} from "../../services/calendarSync/calendarSyncServices.js";

// Feed tokens are `flx_live_` + 40 hex chars. Reject anything else before
// touching the database so scanners don't generate lookups.
const validateToken = z.string().regex(/^flx_live_[a-f0-9]{40}$/, "Invalid feed token");

/**
 * Public, token-authenticated iCalendar feed. Mounted OUTSIDE `authSession`:
 * the token in the URL is the only credential, so calendar clients (which
 * cannot send session cookies) can subscribe. Always responds with
 * `text/calendar` on success.
 */
export const handleGetCalendarFeed = async (req: Request, res: Response) => {
  const parsed = validateToken.safeParse(req.params.token);
  if (!parsed.success) {
    throw new AppError({ code: 404, message: "Calendar feed not found" });
  }

  const config = await getCalendarSyncByToken(parsed.data);

  if (!config) {
    throw new AppError({
      code: 404,
      message: "Calendar feed not found",
      context: { token: parsed.data },
    });
  }

  const records = await getFeedRecords(config);

  const events: IcsEvent[] = records.map((r) => {
    const label = VACATION_TYPE_LABELS[r.vacationType];
    return {
      uid: `${r.id}@flexiday`,
      startDate: r.requestedDay,
      endDate: r.requestedDay,
      summary: `${r.userName} — ${label}`,
      description: r.note ?? undefined,
      categories: [label],
    };
  });

  const body = buildIcsCalendar({ name: config.name, events });

  // Best-effort "last fetched" bookkeeping; never fail the feed over it.
  try {
    await touchLastFetched(config.id);
  } catch {
    // ignore — the feed content is already computed and valid
  }

  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", `inline; filename="${config.id}.ics"`);
  res.setHeader("Cache-Control", "private, max-age=300");
  return res.status(200).send(body);
};
