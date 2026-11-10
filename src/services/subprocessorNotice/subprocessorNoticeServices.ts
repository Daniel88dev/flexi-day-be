import { parseArgs } from "node:util";
import { and, asc, eq, isNull, min } from "drizzle-orm";
import { db } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { subprocessorNotices } from "../../db/schema/subprocessor-notice-schema.js";
import { appLanguage, userSettings } from "../../db/schema/user-settings-schema.js";
import { emailSender } from "../email/index.js";

const SUBPROCESSOR = "anthropic";
const NOTICE_DAYS = 30;
const REPLY_TO = "support@flexi-day.com";
const NOTICE_MS = NOTICE_DAYS * 24 * 60 * 60 * 1000;

const USAGE = `Usage: pnpm run subprocessor-notice --dry-run | --send

Sends the notice that Anthropic becomes a sub-processor to the owner of every organization that
has not had it yet, and records the send. --dry-run lists the recipients and sends nothing.`;

const formatDate = (date: Date, language: appLanguage) =>
  new Intl.DateTimeFormat(language === appLanguage.Czech ? "cs-CZ" : "en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);

const firstSentAt = async (): Promise<Date | null> => {
  const [row] = await db
    .select({ first: min(subprocessorNotices.sentAt) })
    .from(subprocessorNotices)
    .where(eq(subprocessorNotices.subprocessor, SUBPROCESSOR));
  return row?.first ?? null;
};

const owners = () =>
  db
    .select({
      organizationId: organizations.id,
      organizationName: organizations.name,
      ownerUserId: user.id,
      email: user.email,
      name: user.name,
      language: userSettings.language,
      sentAt: subprocessorNotices.sentAt,
    })
    .from(organizations)
    .innerJoin(user, eq(user.id, organizations.ownerUserId))
    .leftJoin(userSettings, eq(userSettings.userId, user.id))
    .leftJoin(
      subprocessorNotices,
      and(
        eq(subprocessorNotices.organizationId, organizations.id),
        eq(subprocessorNotices.subprocessor, SUBPROCESSOR)
      )
    )
    .where(isNull(user.deletedAt))
    .orderBy(asc(organizations.createdAt), asc(organizations.id));

type Owner = Awaited<ReturnType<typeof owners>>[number];

/** Claims the owner's row and sends in one transaction: a failed send records nothing. */
const sendTo = async (owner: Owner, startsAt: Date, sentAt: Date): Promise<boolean> =>
  db.transaction(async (tx) => {
    const claimed = await tx
      .insert(subprocessorNotices)
      .values({
        organizationId: owner.organizationId,
        subprocessor: SUBPROCESSOR,
        ownerUserId: owner.ownerUserId,
        sentAt,
      })
      .onConflictDoNothing()
      .returning({ organizationId: subprocessorNotices.organizationId });
    if (claimed.length === 0) return false;

    const language = owner.language ?? appLanguage.English;
    // Inside the transaction on purpose, unlike other notifications: the row is the only record
    // that the owner was told, so it must not commit unless SES took the message.
    await emailSender.sendTemplated({
      to: owner.email,
      replyTo: REPLY_TO,
      template: "subprocessor-notice",
      data: {
        czech: language === appLanguage.Czech,
        name: owner.name,
        organizationName: owner.organizationName,
        startDate: formatDate(startsAt, language),
      },
    });
    return true;
  });

const describeOwner = (owner: Owner) =>
  `${owner.email}  ${owner.language ?? appLanguage.English}  ${owner.organizationName}`;

/**
 * `pnpm run subprocessor-notice`: sends the Anthropic sub-processor notice once to the owner of
 * every organization, on every plan, and records each send. The first recorded send starts the
 * Assistant's 30 days, and every notice names that day, re-runs included. Answers the exit code:
 * 0 when every owner has it, 1 when a send failed, 2 on bad arguments.
 */
export const runSubprocessorNotice = async (
  argv: string[],
  io: { print: (line: string) => void },
  clock: () => Date = () => new Date()
): Promise<number> => {
  let values: { "dry-run"?: boolean; send?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { "dry-run": { type: "boolean" }, send: { type: "boolean" } },
    }));
  } catch {
    io.print(USAGE);
    return 2;
  }
  const dryRun = values["dry-run"] === true;
  if (dryRun === (values.send === true)) {
    io.print(USAGE);
    return 2;
  }

  const startsAt = new Date(((await firstSentAt()) ?? clock()).getTime() + NOTICE_MS);
  const all = await owners();
  const pending = all.filter((owner) => owner.sentAt === null);
  let alreadySent = all.length - pending.length;

  if (dryRun) {
    io.print("Dry run: nothing is sent or recorded.");
    for (const owner of all) {
      io.print(
        owner.sentAt
          ? `  sent ${owner.sentAt.toISOString()}  ${describeOwner(owner)}`
          : `  would send  ${describeOwner(owner)}`
      );
    }
    io.print(`Would send ${pending.length}, already sent ${alreadySent}.`);
    io.print(`The Assistant may open from ${formatDate(startsAt, appLanguage.English)}.`);
    return 0;
  }

  let sent = 0;
  let failed = 0;
  for (const owner of pending) {
    try {
      if (await sendTo(owner, startsAt, clock())) {
        sent += 1;
        io.print(`  sent  ${describeOwner(owner)}`);
      } else {
        alreadySent += 1;
      }
    } catch (error) {
      failed += 1;
      io.print(
        `  failed ${owner.email}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  io.print(`Sent ${sent}, already sent ${alreadySent}, failed ${failed}.`);
  const first = await firstSentAt();
  if (first) {
    io.print(`First notice sent ${first.toISOString()}.`);
    io.print(
      `The Assistant may open from ${formatDate(new Date(first.getTime() + NOTICE_MS), appLanguage.English)}.`
    );
  }
  return failed > 0 ? 1 : 0;
};
