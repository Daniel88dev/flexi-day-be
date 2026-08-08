import { logger } from "../../middleware/logger.js";
import type { EmailSender, TemplatedEmail } from "./emailSender.js";

/**
 * Reserved TLDs that can never hold a real mailbox: RFC 2606 / RFC 6761
 * (`test`, `example`, `invalid`, `localhost`) plus RFC 6762's `local`, which
 * is mDNS-only and covers the `@dev.local` accounts the seeding surface
 * creates.
 */
const UNDELIVERABLE_TLDS = new Set(["test", "example", "invalid", "localhost", "local"]);

/** RFC 2606 second-level domains reserved for documentation and examples. */
const UNDELIVERABLE_DOMAINS = new Set(["example.com", "example.net", "example.org"]);

/**
 * True when the address provably cannot receive mail. Delivering to one only
 * ever produces a hard bounce, and bounces are charged against the SES
 * account's sender reputation — so these are dropped before they reach AWS.
 *
 * Deliberately keyed on reserved domains alone, not on `NODE_ENV` or the dev
 * seed domain: pointing `DEV_SEED_EMAIL_DOMAIN` at a domain you own is how you
 * exercise real delivery locally, and that must keep sending.
 */
export const isUndeliverableAddress = (address: string): boolean => {
  const domain = address.trim().toLowerCase().split("@").pop();
  if (!domain) return false;

  if (UNDELIVERABLE_DOMAINS.has(domain)) return true;

  const tld = domain.split(".").pop();
  return tld !== undefined && UNDELIVERABLE_TLDS.has(tld);
};

/**
 * Wraps an {@link EmailSender} so undeliverable recipients are logged and
 * dropped instead of sent. Applied to every sender, production included — a
 * reserved-domain address in production is bad data, and bouncing it costs
 * reputation that real mail depends on.
 */
export const suppressUndeliverable = (inner: EmailSender): EmailSender => ({
  async sendTemplated(email: TemplatedEmail): Promise<void> {
    if (isUndeliverableAddress(email.to)) {
      logger.info("email.suppressed", { to: email.to, template: email.template });
      return;
    }

    await inner.sendTemplated(email);
  },
});
