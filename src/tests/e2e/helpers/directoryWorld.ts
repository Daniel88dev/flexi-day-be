import request from "supertest";
import { db } from "../../../db/db.js";
import { subscriptionPlan, subscriptionStatus } from "../../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../../../services/billing/subscriptionServices.js";
import { enableDirectory } from "../../../services/directory/directorySettingsServices.js";
import { authCookieFor } from "./authHelper.js";

/** The `code` a refusal carries in `errors[0].context`. */
export const errorCode = (res: request.Response) => res.body.errors?.[0]?.context?.code;

/** A client signed in as `userId` against the loopback server at `serverUrl`. */
export const apiAs = async (serverUrl: string, userId: string) => {
  const cookie = await authCookieFor(userId);
  return {
    get: (path: string) => request(serverUrl).get(path).set("Cookie", cookie),
    post: (path: string, body: object = {}) =>
      request(serverUrl).post(path).set("Cookie", cookie).send(body),
    put: (path: string, body: object = {}) =>
      request(serverUrl).put(path).set("Cookie", cookie).send(body),
    patch: (path: string, body: object) =>
      request(serverUrl).patch(path).set("Cookie", cookie).send(body),
    delete: (path: string) => request(serverUrl).delete(path).set("Cookie", cookie),
  };
};

/** Puts the organization on an active Enterprise plan and turns its directory on as the owner. */
export const enableEnterpriseDirectory = async (organizationId: string, ownerId: string) => {
  await upsertSubscription(organizationId, {
    plan: subscriptionPlan.Enterprise,
    status: subscriptionStatus.Active,
    graceEndsAt: null,
  });
  await db.transaction((tx) =>
    enableDirectory({ organizationId, userId: ownerId, agreementVersion: 1 }, tx)
  );
};
