import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Where a change or a read came from: the web or iPhone app, the Assistant, or
 * an AI app connected over MCP. Stored on `vacation_events`, `attendance_events`
 * and `read_log`; rows from before the column read as `app`.
 */
export const changeChannels = ["app", "assistant", "mcp"] as const;

export type ChangeChannel = (typeof changeChannels)[number];

export const changeChannelEnum = pgEnum("change_channel", changeChannels);
