import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../middleware/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  isUndeliverableAddress,
  suppressUndeliverable,
} from "../../../services/email/suppressUndeliverable.js";
import type { EmailSender, TemplatedEmail } from "../../../services/email/emailSender.js";

const email = (to: string): TemplatedEmail => ({
  to,
  template: "email-confirmation",
  data: { name: "Olivia", confirmationUrl: "https://example.test/c", expiresIn: "1 hour" },
});

describe("isUndeliverableAddress", () => {
  it.each([
    "owner@dev.local",
    "alice@DEV.LOCAL",
    "  bob@dev.local  ",
    "carol@anything.test",
    "dan@foo.invalid",
    "eve@app.localhost",
    "frank@example.com",
    "grace@example.org",
  ])("suppresses %s", (address) => {
    expect(isUndeliverableAddress(address)).toBe(true);
  });

  it.each([
    "daniel@hrynusiw.cz",
    "someone@flexi-day.com",
    "user@localhost.co.uk",
    "team@example.company",
  ])("allows %s", (address) => {
    expect(isUndeliverableAddress(address)).toBe(false);
  });
});

describe("suppressUndeliverable", () => {
  let inner: EmailSender;
  let sendTemplated: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendTemplated = vi.fn().mockResolvedValue(undefined);
    inner = { sendTemplated } as unknown as EmailSender;
  });

  it("drops mail to a seeded dev address without calling the inner sender", async () => {
    await suppressUndeliverable(inner).sendTemplated(email("owner@dev.local"));

    expect(sendTemplated).not.toHaveBeenCalled();
  });

  it("passes real addresses through untouched", async () => {
    const message = email("daniel@hrynusiw.cz");

    await suppressUndeliverable(inner).sendTemplated(message);

    expect(sendTemplated).toHaveBeenCalledWith(message);
  });

  it("propagates a failure from the inner sender", async () => {
    sendTemplated.mockRejectedValue(new Error("SES down"));

    await expect(
      suppressUndeliverable(inner).sendTemplated(email("daniel@hrynusiw.cz"))
    ).rejects.toThrow("SES down");
  });
});
