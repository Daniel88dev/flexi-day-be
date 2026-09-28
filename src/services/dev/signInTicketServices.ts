import crypto from "crypto";

export const SIGN_IN_TICKET_TTL_MS = 60 * 1000;

type TicketEntry = { userId: string; expiresAt: number };

// In memory on purpose — see "Dev sign-in ticket" in docs/invariants.md.
const tickets = new Map<string, TicketEntry>();

const sweep = (now: number) => {
  for (const [ticket, entry] of tickets) {
    if (entry.expiresAt <= now) tickets.delete(ticket);
  }
};

export const mintSignInTicket = (userId: string): { ticket: string; expiresAt: Date } => {
  const now = Date.now();
  sweep(now);

  const ticket = crypto.randomBytes(32).toString("base64url");
  const expiresAt = now + SIGN_IN_TICKET_TTL_MS;
  tickets.set(ticket, { userId, expiresAt });

  return { ticket, expiresAt: new Date(expiresAt) };
};

/** The user a live ticket was minted for, or null. Spends the ticket either way. */
export const consumeSignInTicket = (ticket: string): string | null => {
  const entry = tickets.get(ticket);
  tickets.delete(ticket);
  if (!entry || entry.expiresAt <= Date.now()) return null;

  return entry.userId;
};
