import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { subprocessorNotices } from "../../db/schema/subprocessor-notice-schema.js";
import { appLanguage, userSettings } from "../../db/schema/user-settings-schema.js";
import type { TemplatedEmail } from "../../services/email/index.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { runSubprocessorNotice } from "../../services/subprocessorNotice/subprocessorNoticeServices.js";
import { makeUser, resetReportData } from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";

const sendTemplated = vi.fn<(email: TemplatedEmail) => Promise<void>>();
vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: (email: TemplatedEmail) => sendTemplated(email) },
}));

const DAY_0 = new Date("2026-11-20T09:30:00Z");

describe("pnpm run subprocessor-notice", () => {
  let printed: string[];
  const io = { print: (line: string) => printed.push(line) };
  const run = (argv: string[], now = DAY_0) => runSubprocessorNotice(argv, io, () => now);

  const owner = async (
    name: string,
    organizationName: string,
    options: { language?: appLanguage; plan?: subscriptionPlan } = {}
  ) => {
    const person = await makeUser(name);
    const organization = await ensureOrganizationForUser(person.id);
    await db
      .update(organizations)
      .set({ name: organizationName })
      .where(eq(organizations.id, organization.id));
    if (options.language) {
      await db.insert(userSettings).values({ userId: person.id, language: options.language });
    }
    if (options.plan) {
      await upsertSubscription(organization.id, {
        plan: options.plan,
        status: subscriptionStatus.Active,
        graceEndsAt: null,
      });
    }
    return { ...person, organizationId: organization.id };
  };

  const sentTo = () => sendTemplated.mock.calls.map(([email]) => email.to).sort();

  beforeEach(async () => {
    printed = [];
    sendTemplated.mockReset();
    sendTemplated.mockResolvedValue(undefined);
    await cleanupTestData();
    await resetReportData();
  });

  afterAll(async () => {
    await cleanupTestData();
    await resetReportData();
  });

  it("sends every owner on every plan the notice in their language, and records the send", async () => {
    const olga = await owner("Olga Owner", "Northwind", { plan: subscriptionPlan.Enterprise });
    const petr = await owner("Petr Vlastník", "Severka", { language: appLanguage.Czech });

    expect(await run(["--send"])).toBe(0);

    expect(sentTo()).toEqual([olga.email, petr.email].sort());
    const toOlga = sendTemplated.mock.calls.find(([email]) => email.to === olga.email)![0];
    expect(toOlga).toEqual({
      to: olga.email,
      replyTo: "support@flexi-day.com",
      template: "subprocessor-notice",
      data: {
        czech: false,
        name: "Olga Owner",
        organizationName: "Northwind",
        startDate: "20 December 2026",
      },
    });
    const toPetr = sendTemplated.mock.calls.find(([email]) => email.to === petr.email)![0];
    expect(toPetr.data).toEqual({
      czech: true,
      name: "Petr Vlastník",
      organizationName: "Severka",
      startDate: "20. prosince 2026",
    });

    const rows = await db.select().from(subprocessorNotices);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.subprocessor).toBe("anthropic");
      expect(row.sentAt).toEqual(DAY_0);
    }
    expect(rows.map((row) => row.ownerUserId).sort()).toEqual([olga.id, petr.id].sort());

    const output = printed.join("\n");
    expect(output).toContain("Sent 2, already sent 0, failed 0.");
    expect(output).toContain("First notice sent 2026-11-20T09:30:00.000Z.");
    expect(output).toContain("The Assistant may open from 20 December 2026.");
  });

  it("reaches each owner once when re-run, and names the first send's date to a later owner", async () => {
    const olga = await owner("Olga Owner", "Northwind");
    expect(await run(["--send"])).toBe(0);
    const [first] = await db.select().from(subprocessorNotices);

    sendTemplated.mockClear();
    printed = [];
    const later = await owner("Lena Later", "Latecomers");
    expect(await run(["--send"], new Date("2026-11-25T12:00:00Z"))).toBe(0);

    expect(sentTo()).toEqual([later.email]);
    expect(sendTemplated.mock.calls[0]![0].data).toMatchObject({ startDate: "20 December 2026" });
    expect(printed.join("\n")).toContain("Sent 1, already sent 1, failed 0.");

    sendTemplated.mockClear();
    expect(await run(["--send"])).toBe(0);
    expect(sendTemplated).not.toHaveBeenCalled();

    const [olgaRow] = await db
      .select()
      .from(subprocessorNotices)
      .where(eq(subprocessorNotices.organizationId, olga.organizationId));
    expect(olgaRow!.sentAt).toEqual(first!.sentAt);
  });

  it("records nothing for an owner whose send fails, so the next run tries again", async () => {
    const olga = await owner("Olga Owner", "Northwind");
    await owner("Petr Vlastník", "Severka", { language: appLanguage.Czech });
    sendTemplated.mockImplementation(async (email) => {
      if (email.to === olga.email) throw new Error("SES said no");
    });

    expect(await run(["--send"])).toBe(1);
    expect(await db.select().from(subprocessorNotices)).toHaveLength(1);
    expect(printed.join("\n")).toContain(`failed ${olga.email}: SES said no`);
    expect(printed.join("\n")).toContain("Sent 1, already sent 0, failed 1.");

    sendTemplated.mockReset();
    sendTemplated.mockResolvedValue(undefined);
    expect(await run(["--send"])).toBe(0);
    expect(sentTo()).toEqual([olga.email]);
  });

  it("skips an owner whose account was deleted", async () => {
    const gone = await owner("Gone Owner", "Ghost Org");
    await db.update(user).set({ deletedAt: new Date() }).where(eq(user.id, gone.id));

    expect(await run(["--send"])).toBe(0);
    expect(sendTemplated).not.toHaveBeenCalled();
  });

  it("lists the recipients on a dry run and sends and records nothing", async () => {
    const olga = await owner("Olga Owner", "Northwind");
    const petr = await owner("Petr Vlastník", "Severka", { language: appLanguage.Czech });

    expect(await run(["--dry-run"])).toBe(0);

    expect(sendTemplated).not.toHaveBeenCalled();
    expect(await db.select().from(subprocessorNotices)).toHaveLength(0);
    const output = printed.join("\n");
    expect(output).toContain("Dry run: nothing is sent or recorded.");
    expect(output).toContain(`${olga.email}  en  Northwind`);
    expect(output).toContain(`${petr.email}  cs  Severka`);
    expect(output).toContain("Would send 2, already sent 0.");
    expect(output).toContain("The Assistant may open from 20 December 2026.");
  });

  it("refuses to guess between a dry run and a send", async () => {
    await owner("Olga Owner", "Northwind");
    expect(await run([])).toBe(2);
    expect(await run(["--dry-run", "--send"])).toBe(2);
    expect(await run(["--sned"])).toBe(2);
    expect(sendTemplated).not.toHaveBeenCalled();
    expect(printed[0]).toMatch(/^Usage: pnpm run subprocessor-notice --dry-run \| --send/);
  });
});
