import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import type { Response } from "supertest";
import { eq, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import {
  setupTestEnvironment,
  cleanupTestData,
  createTestVacation,
  type TestContext,
} from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { db } from "../../db/db.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { vacationEvents, vacationEventType } from "../../db/schema/vacation-event-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { session } from "../../db/schema/auth-schema.js";

describe("Vacation decision routes E2E", () => {
  let context: TestContext;
  let approverCookie: string;

  const eventsFor = async (vacationId: string) =>
    db.select().from(vacationEvents).where(eq(vacationEvents.vacationId, vacationId));

  const rowFor = async (vacationId: string) =>
    (await db.select().from(vacation).where(eq(vacation.id, vacationId)))[0];

  const messagesOf = (response: Response) =>
    (response.body as { errors: { message: string }[] }).errors.map((error) => error.message);

  /** Resolves once a backend is waiting on a lock held by `holderPid`, and no other. */
  const waitUntilBlockedBy = async (holderPid: number) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const { rows } = await db.execute<{ waiting: number }>(
        sql`select count(*)::int as waiting from pg_stat_activity
            where pid <> pg_backend_pid() and ${holderPid} = any(pg_blocking_pids(pid))`
      );
      if ((rows[0]?.waiting ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("the request never blocked on the row lock held by the test");
  };

  /**
   * Drives the lost-race branch. A held transaction decides the row without
   * committing, so the request's snapshot read still sees it pending and clears
   * every guard, and its UPDATE then blocks on the lock. Committing the decision
   * makes that UPDATE re-check its predicate, skip the row and come back short —
   * the only path to the bulk conflict wording.
   */
  const raceRequestAgainstDecision = async (
    vacationId: string,
    stamp: Partial<typeof vacation.$inferInsert>,
    sendRequest: () => Promise<Response>
  ): Promise<Response> => {
    let announceLocked!: (holderPid: number) => void;
    const locked = new Promise<number>((resolve) => (announceLocked = resolve));
    let commit!: () => void;
    const decided = new Promise<void>((resolve) => (commit = resolve));

    const holder = db.transaction(async (tx) => {
      const { rows } = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      await tx.update(vacation).set(stamp).where(eq(vacation.id, vacationId));
      announceLocked(rows[0]?.pid ?? 0);
      await decided;
    });

    let pending: Promise<Response> | undefined;
    try {
      const holderPid = await Promise.race([
        locked,
        holder.then(() =>
          Promise.reject(new Error("the holding transaction ended before the row was locked"))
        ),
      ]);
      // supertest sends nothing until the request is awaited, so start it here.
      pending = Promise.resolve(sendRequest());
      await waitUntilBlockedBy(holderPid);
      commit();
      await holder;
      return await pending;
    } finally {
      commit();
      await holder.catch(() => undefined);
      await pending?.catch(() => undefined);
    }
  };

  beforeAll(async () => {
    context = await setupTestEnvironment();
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  beforeEach(async () => {
    await db.delete(vacation);
    await db.delete(groupUsers);
    await db.delete(session);
    approverCookie = await authCookieFor(context.approverUser.id);
  });

  describe("POST /api/vacation/reject/:id", () => {
    let vacationId: string;

    beforeEach(async () => {
      vacationId = await createTestVacation(context.user1.id, context.group.id, "2025-12-24");
    });

    it("rejects the request, stamps the rejecter and records the reason on the timeline", async () => {
      const response = await request(context.app)
        .post(`/api/vacation/reject/${vacationId}`)
        .set("Cookie", approverCookie)
        .send({ reason: "the team is short that week" })
        .expect(200);

      expect(response.body).toEqual({ message: "Vacation rejected" });

      const row = await rowFor(vacationId);
      expect(row?.rejectedAt).not.toBeNull();
      expect(row?.rejectedBy).toBe(context.approverUser.id);
      expect(row?.rejectionReason).toBe("the team is short that week");
      expect(row?.approvedAt).toBeNull();

      const events = await eventsFor(vacationId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        eventType: vacationEventType.Rejected,
        actorUserId: context.approverUser.id,
        reason: "the team is short that week",
      });
    });

    it("returns 403 for a caller with no approver standing in the group", async () => {
      const cookie = await authCookieFor(context.user2.id);

      const response = await request(context.app)
        .post(`/api/vacation/reject/${vacationId}`)
        .set("Cookie", cookie)
        .send({ reason: "no" })
        .expect(403);

      expect(messagesOf(response)).toEqual([
        "You are not allowed to reject one or more of these requests",
      ]);

      const row = await rowFor(vacationId);
      expect(row?.rejectedAt).toBeNull();
      expect(await eventsFor(vacationId)).toHaveLength(0);
    });

    it("returns 409 with the single-record wording once the request is decided", async () => {
      await db
        .update(vacation)
        .set({
          rejectedAt: new Date(),
          rejectedBy: context.approverUser.id,
          rejectionReason: "first",
        })
        .where(eq(vacation.id, vacationId));

      const response = await request(context.app)
        .post(`/api/vacation/reject/${vacationId}`)
        .set("Cookie", approverCookie)
        .send({ reason: "second" })
        .expect(409);

      expect(messagesOf(response)).toEqual(["This request has already been decided"]);

      expect((await rowFor(vacationId))?.rejectionReason).toBe("first");
      expect(await eventsFor(vacationId)).toHaveLength(0);
    });

    it("returns 404 for an id that does not exist", async () => {
      const response = await request(context.app)
        .post(`/api/vacation/reject/${uuidv4()}`)
        .set("Cookie", approverCookie)
        .send({ reason: "no" })
        .expect(404);

      expect(messagesOf(response)).toEqual(["Vacation not found"]);
    });
  });

  describe("POST /api/vacation/approve", () => {
    let ids: string[];

    beforeEach(async () => {
      ids = [
        await createTestVacation(context.user1.id, context.group.id, "2025-12-22"),
        await createTestVacation(context.user1.id, context.group.id, "2025-12-23"),
        await createTestVacation(context.user2.id, context.group.id, "2025-12-22"),
      ];
    });

    it("approves every record in the batch and appends one event per record", async () => {
      const response = await request(context.app)
        .post("/api/vacation/approve")
        .set("Cookie", approverCookie)
        .send({ ids })
        .expect(200);

      expect(response.body).toEqual({ message: "Vacations approved", approvedCount: 3 });

      for (const id of ids) {
        const row = await rowFor(id);
        expect(row?.approvedAt).not.toBeNull();
        expect(row?.approvedBy).toBe(context.approverUser.id);

        const events = await eventsFor(id);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          eventType: vacationEventType.Approved,
          actorUserId: context.approverUser.id,
          reason: null,
        });
      }
    });

    it("approves a batch carrying exactly one id", async () => {
      const id = ids[0] ?? "";

      const response = await request(context.app)
        .post("/api/vacation/approve")
        .set("Cookie", approverCookie)
        .send({ ids: [id] })
        .expect(200);

      expect(response.body).toEqual({ message: "Vacations approved", approvedCount: 1 });
      expect((await rowFor(id))?.approvedAt).not.toBeNull();
      expect((await rowFor(ids[1] ?? ""))?.approvedAt).toBeNull();
    });

    it("returns 403 for a caller with no approver standing in the group", async () => {
      const cookie = await authCookieFor(context.user2.id);
      const othersIds = [ids[0] ?? "", ids[1] ?? ""];

      const response = await request(context.app)
        .post("/api/vacation/approve")
        .set("Cookie", cookie)
        .send({ ids: othersIds })
        .expect(403);

      expect(messagesOf(response)).toEqual([
        "You are not allowed to approve one or more of these requests",
      ]);

      for (const id of othersIds) {
        expect((await rowFor(id))?.approvedAt).toBeNull();
        expect(await eventsFor(id)).toHaveLength(0);
      }
    });

    it("returns 409 with the single-record wording when a record in the batch is already decided", async () => {
      await db
        .update(vacation)
        .set({ approvedAt: new Date(), approvedBy: context.approverUser.id })
        .where(eq(vacation.id, ids[0] ?? ""));

      const response = await request(context.app)
        .post("/api/vacation/approve")
        .set("Cookie", approverCookie)
        .send({ ids })
        .expect(409);

      // The pre-read guard is shared with the single-record route, so a batch
      // whose rows are already decided answers in the single-record wording.
      expect(messagesOf(response)).toEqual(["This request has already been decided"]);

      expect((await rowFor(ids[1] ?? ""))?.approvedAt).toBeNull();
    });

    it("returns 409 with the bulk wording when a single-id batch loses the race", async () => {
      const id = ids[0] ?? "";

      const response = await raceRequestAgainstDecision(
        id,
        { approvedAt: new Date(), approvedBy: context.approverUser.id },
        () =>
          request(context.app)
            .post("/api/vacation/approve")
            .set("Cookie", approverCookie)
            .send({ ids: [id] })
      );

      expect(response.status).toBe(409);
      expect(messagesOf(response)).toEqual([
        "One or more of these requests has already been decided",
      ]);
      expect(await eventsFor(id)).toHaveLength(0);
    });

    it("returns 404 when one of the ids does not exist", async () => {
      const response = await request(context.app)
        .post("/api/vacation/approve")
        .set("Cookie", approverCookie)
        .send({ ids: [...ids, uuidv4()] })
        .expect(404);

      expect(messagesOf(response)).toEqual(["One or more vacations not found"]);

      for (const id of ids) {
        expect((await rowFor(id))?.approvedAt).toBeNull();
      }
    });
  });

  describe("POST /api/vacation/reject", () => {
    let ids: string[];

    beforeEach(async () => {
      ids = [
        await createTestVacation(context.user1.id, context.group.id, "2025-12-22"),
        await createTestVacation(context.user1.id, context.group.id, "2025-12-23"),
        await createTestVacation(context.user2.id, context.group.id, "2025-12-22"),
      ];
    });

    it("rejects every record in the batch and appends one event per record carrying the reason", async () => {
      const response = await request(context.app)
        .post("/api/vacation/reject")
        .set("Cookie", approverCookie)
        .send({ ids, reason: "we cannot cover those days" })
        .expect(200);

      expect(response.body).toEqual({ message: "Vacations rejected", rejectedCount: 3 });

      for (const id of ids) {
        const row = await rowFor(id);
        expect(row?.rejectedAt).not.toBeNull();
        expect(row?.rejectedBy).toBe(context.approverUser.id);
        expect(row?.rejectionReason).toBe("we cannot cover those days");

        const events = await eventsFor(id);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          eventType: vacationEventType.Rejected,
          actorUserId: context.approverUser.id,
          reason: "we cannot cover those days",
        });
      }
    });

    it("returns 403 for a caller with no approver standing in the group", async () => {
      const cookie = await authCookieFor(context.user2.id);
      const othersIds = [ids[0] ?? "", ids[1] ?? ""];

      const response = await request(context.app)
        .post("/api/vacation/reject")
        .set("Cookie", cookie)
        .send({ ids: othersIds, reason: "no" })
        .expect(403);

      expect(messagesOf(response)).toEqual([
        "You are not allowed to reject one or more of these requests",
      ]);

      for (const id of othersIds) {
        expect((await rowFor(id))?.rejectedAt).toBeNull();
        expect(await eventsFor(id)).toHaveLength(0);
      }
    });

    it("returns 409 with the single-record wording when a record in the batch is already decided", async () => {
      await db
        .update(vacation)
        .set({
          rejectedAt: new Date(),
          rejectedBy: context.approverUser.id,
          rejectionReason: "first",
        })
        .where(eq(vacation.id, ids[0] ?? ""));

      const response = await request(context.app)
        .post("/api/vacation/reject")
        .set("Cookie", approverCookie)
        .send({ ids, reason: "second" })
        .expect(409);

      // Same shared pre-read guard as bulk approve: the single-record wording.
      expect(messagesOf(response)).toEqual(["This request has already been decided"]);

      expect((await rowFor(ids[1] ?? ""))?.rejectedAt).toBeNull();
    });

    it("returns 409 with the bulk wording when a single-id batch loses the race", async () => {
      const id = ids[0] ?? "";

      const response = await raceRequestAgainstDecision(
        id,
        { rejectedAt: new Date(), rejectedBy: context.approverUser.id, rejectionReason: "first" },
        () =>
          request(context.app)
            .post("/api/vacation/reject")
            .set("Cookie", approverCookie)
            .send({ ids: [id], reason: "second" })
      );

      expect(response.status).toBe(409);
      expect(messagesOf(response)).toEqual([
        "One or more of these requests has already been decided",
      ]);
      expect((await rowFor(id))?.rejectionReason).toBe("first");
      expect(await eventsFor(id)).toHaveLength(0);
    });

    it("returns 404 when one of the ids does not exist", async () => {
      const response = await request(context.app)
        .post("/api/vacation/reject")
        .set("Cookie", approverCookie)
        .send({ ids: [...ids, uuidv4()], reason: "no" })
        .expect(404);

      expect(messagesOf(response)).toEqual(["One or more vacations not found"]);

      for (const id of ids) {
        expect((await rowFor(id))?.rejectedAt).toBeNull();
      }
    });
  });
});
