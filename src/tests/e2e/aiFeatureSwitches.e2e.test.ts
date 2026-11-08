import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { config } from "../../config.js";
import { createServer } from "../../server.js";
import { db } from "../../db/db.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { authSession } from "../../middleware/authSession.js";
import { errorMiddleware } from "../../middleware/errorMiddleware.js";
import { organizationIdParam, requireAiFeature } from "../../middleware/aiFeatureGuard.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { cleanupTestData, createTestGroup, createTestUser } from "./helpers/testSetup.js";
import { getOrganizationForOwner } from "../../services/organization/organizationServices.js";

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

const OFF = { assistantEnabled: false, aiConnectionsEnabled: false, previewOrganizationIds: [] };

/** The routes later tickets mount behind the guard, one per way of naming the organization. */
const placeholderApp = () => {
  const app = express();
  app.get(
    "/public/assistant",
    requireAiFeature("assistant", "public"),
    (_req, res) => void res.json({ ok: true })
  );
  app.use(authSession);
  app.get(
    "/organizations/:organizationId/assistant",
    requireAiFeature("assistant", { organizationId: organizationIdParam("organizationId") }),
    (_req, res) => void res.json({ ok: true })
  );
  app.get(
    "/organizations/:organizationId/ai-connections",
    requireAiFeature("aiConnections", { organizationId: organizationIdParam("organizationId") }),
    (_req, res) => void res.json({ ok: true })
  );
  app.get(
    "/me/assistant",
    requireAiFeature("assistant", "caller"),
    (_req, res) => void res.json({ ok: true })
  );
  app.use(errorMiddleware);
  return app;
};

describe("AI feature kill switches and the preview list", () => {
  let api: LoopbackServer;
  let placeholder: LoopbackServer;
  let previewOrgId: string;
  let otherOrgId: string;
  let memberCookie: string;
  let outsiderCookie: string;
  let loneCookie: string;

  const setSwitches = (patch: Partial<typeof config.aiFeatures>) => {
    config.aiFeatures = { ...OFF, ...patch };
  };

  beforeAll(async () => {
    await cleanupTestData();
    const owner = await createTestUser("ai-owner@test.com", "AI Owner", "x");
    const member = await createTestUser("ai-member@test.com", "AI Member", "x");
    const outsider = await createTestUser("ai-outsider@test.com", "AI Outsider", "x");
    const lone = await createTestUser("ai-lone@test.com", "AI Lone", "x");

    const group = await createTestGroup("AI Preview Group", owner.id);
    await db.insert(groupUsers).values({ id: uuidv4(), groupId: group.id, userId: member.id });
    await createTestGroup("AI Other Group", outsider.id);
    previewOrgId = (await getOrganizationForOwner(owner.id))!.id;
    otherOrgId = (await getOrganizationForOwner(outsider.id))!.id;

    memberCookie = await authCookieFor(member.id);
    outsiderCookie = await authCookieFor(outsider.id);
    loneCookie = await authCookieFor(lone.id);

    api = await listenOnLoopback(createServer());
    placeholder = await listenOnLoopback(placeholderApp());
  });

  afterEach(() => {
    setSwitches({});
  });

  afterAll(async () => {
    setSwitches({});
    await api?.close();
    await placeholder?.close();
    await cleanupTestData();
  });

  const availability = (cookie: string) =>
    request(api.url).get("/api/ai-features/availability").set("Cookie", cookie);

  const placeholderGet = (path: string, cookie?: string) => {
    const req = request(placeholder.url).get(path);
    return cookie ? req.set("Cookie", cookie) : req;
  };

  describe("availability", () => {
    it("answers both features unavailable while the switches are off", async () => {
      const res = await availability(memberCookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        assistant: false,
        aiConnections: false,
        organizations: [
          {
            organizationId: previewOrgId,
            assistant: false,
            aiConnections: false,
            newAgreementVersionReady: false,
          },
        ],
      });
    });

    it("makes both features available to a member of a preview organization only", async () => {
      setSwitches({ previewOrganizationIds: [previewOrgId] });

      const member = await availability(memberCookie);
      const outsider = await availability(outsiderCookie);

      expect(member.body).toEqual({
        assistant: true,
        aiConnections: true,
        organizations: [
          {
            organizationId: previewOrgId,
            assistant: true,
            aiConnections: true,
            newAgreementVersionReady: false,
          },
        ],
      });
      expect(outsider.body).toEqual({
        assistant: false,
        aiConnections: false,
        organizations: [
          {
            organizationId: otherOrgId,
            assistant: false,
            aiConnections: false,
            newAgreementVersionReady: false,
          },
        ],
      });
    });

    it("opens one feature for everyone when its switch is on", async () => {
      setSwitches({ assistantEnabled: true });

      const outsider = await availability(outsiderCookie);
      const lone = await availability(loneCookie);

      expect(outsider.body).toEqual({
        assistant: true,
        aiConnections: false,
        organizations: [
          {
            organizationId: otherOrgId,
            assistant: true,
            aiConnections: false,
            newAgreementVersionReady: false,
          },
        ],
      });
      expect(lone.body).toEqual({ assistant: true, aiConnections: false, organizations: [] });
    });

    it("needs a session", async () => {
      const res = await request(api.url).get("/api/ai-features/availability");
      expect(res.status).toBe(401);
    });
  });

  describe("guard on an organization's route", () => {
    it("answers 404 while the switch is off", async () => {
      const res = await placeholderGet(`/organizations/${previewOrgId}/assistant`, memberCookie);
      expect(res.status).toBe(404);
    });

    it("answers 200 for an organization on the preview list and 404 for one off it", async () => {
      setSwitches({ previewOrganizationIds: [previewOrgId] });

      const listed = await placeholderGet(`/organizations/${previewOrgId}/assistant`, memberCookie);
      const unlisted = await placeholderGet(
        `/organizations/${otherOrgId}/assistant`,
        outsiderCookie
      );

      expect(listed.status).toBe(200);
      expect(listed.body).toEqual({ ok: true });
      expect(unlisted.status).toBe(404);
    });

    it("answers 200 for any organization once the switch is on", async () => {
      setSwitches({ assistantEnabled: true });

      const res = await placeholderGet(`/organizations/${otherOrgId}/assistant`, outsiderCookie);
      expect(res.status).toBe(200);
    });

    it("keeps the two switches apart", async () => {
      setSwitches({ aiConnectionsEnabled: true });

      const assistant = await placeholderGet(
        `/organizations/${otherOrgId}/assistant`,
        outsiderCookie
      );
      const connections = await placeholderGet(
        `/organizations/${otherOrgId}/ai-connections`,
        outsiderCookie
      );

      expect(assistant.status).toBe(404);
      expect(connections.status).toBe(200);
    });
  });

  describe("guard on a caller's route", () => {
    it("answers 404 while the switch is off", async () => {
      expect((await placeholderGet("/me/assistant", memberCookie)).status).toBe(404);
    });

    it("answers 200 only to someone in a preview organization", async () => {
      setSwitches({ previewOrganizationIds: [previewOrgId] });

      expect((await placeholderGet("/me/assistant", memberCookie)).status).toBe(200);
      expect((await placeholderGet("/me/assistant", outsiderCookie)).status).toBe(404);
      expect((await placeholderGet("/me/assistant", loneCookie)).status).toBe(404);
    });

    it("answers 200 to anyone once the switch is on", async () => {
      setSwitches({ assistantEnabled: true });
      expect((await placeholderGet("/me/assistant", loneCookie)).status).toBe(200);
    });
  });

  describe("guard on a public route", () => {
    it("answers 404 while the switch is off and the preview list is empty", async () => {
      expect((await placeholderGet("/public/assistant")).status).toBe(404);
    });

    it("answers 200 while any organization is on the preview list", async () => {
      setSwitches({ previewOrganizationIds: [previewOrgId] });
      expect((await placeholderGet("/public/assistant")).status).toBe(200);
    });
  });
});
