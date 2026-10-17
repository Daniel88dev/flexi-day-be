import type { pushEnvironment } from "../../db/schema/push-registration-schema.js";

export type ApnsPayload = {
  aps: {
    alert: { title: string; body: string };
    badge: number;
    sound?: "default";
    "interruption-level"?: "passive";
  };
  notificationId: string;
  href: string | null;
};

export type ApnsPush = {
  environment: pushEnvironment;
  token: string;
  payload: ApnsPayload;
  signal?: AbortSignal;
};

/** The HTTP status APNs answered with, and the `reason` from its body when it refused. */
export type ApnsAnswer = { status: number; reason?: string };

export type ApnsSender = { send(push: ApnsPush): Promise<ApnsAnswer> };
