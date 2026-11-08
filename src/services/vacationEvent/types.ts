import type { ChangeChannel } from "../../db/schema/change-channel-schema.js";
import type { vacationEventType } from "../../db/schema/vacation-event-schema.js";
import type { UserSummary } from "../../utils/userPresentation.js";

export type VacationEventRecord = {
  id: string;
  vacationId: string;
  eventType: vacationEventType;
  actorUserId: string | null;
  reason: string | null;
  channel: ChangeChannel;
  createdAt: Date;
};

export type VacationEventInsertType = {
  id: string;
  vacationId: string;
  eventType: vacationEventType;
  actorUserId: string | null;
  reason?: string | null;
  channel: ChangeChannel;
};

/** A timeline entry as returned to the client: the actor is resolved to a summary. */
export type VacationEventListItem = Omit<VacationEventRecord, "actorUserId"> & {
  actor: UserSummary | null;
};
