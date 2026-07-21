import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture what the adapter passes to the AWS SDK without hitting the network.
// Hoisted so it exists before the mock factory (also hoisted) references it.
const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn().mockResolvedValue({}),
}));

vi.mock("@aws-sdk/client-sesv2", () => {
  class SESv2Client {
    send = sendMock;
  }
  // The command just wraps its input so we can assert on it.
  class SendEmailCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return { SESv2Client, SendEmailCommand };
});

import { sesEmailSender } from "../../../services/email/sesEmailSender.js";

const validEmail = {
  to: "user@example.com",
  template: "email-confirmation" as const,
  data: {
    name: "Daniel",
    confirmationUrl: "https://api.flexi-day.com/api/auth/verify-email?token=x",
    expiresIn: "1 hour",
  },
};

describe("sesEmailSender", () => {
  beforeEach(() => {
    sendMock.mockClear();
  });

  it("sends the stage-suffixed template with JSON-encoded data", async () => {
    await sesEmailSender.sendTemplated(validEmail);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const input = sendMock.mock.calls[0][0].input as {
      Destination: { ToAddresses: string[] };
      Content: { Template: { TemplateName: string; TemplateData: string } };
    };

    expect(input.Destination.ToAddresses).toEqual(["user@example.com"]);
    // NODE_ENV is "test" in the vitest env, so the stage defaults to "dev".
    expect(input.Content.Template.TemplateName).toBe("flexi-day-email-confirmation-dev");
    expect(JSON.parse(input.Content.Template.TemplateData)).toEqual(validEmail.data);
  });

  it("throws and does not send when a template variable is blank", async () => {
    await expect(
      sesEmailSender.sendTemplated({
        ...validEmail,
        data: { ...validEmail.data, name: "  " },
      })
    ).rejects.toThrow(/name/);

    expect(sendMock).not.toHaveBeenCalled();
  });
});
