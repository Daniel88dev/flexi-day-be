import { beforeEach, describe, expect, it } from "vitest";
import AppError from "../../../../utils/appError.js";
import { buildAgentConfig } from "../../agent/agentConfig.js";
import { provisionAssistant } from "../../agent/agentSync.js";
import {
  createFakeManagedAgentsApi,
  type FakeManagedAgentsApi,
} from "../../tests/fakeManagedAgentsApi.js";
import { createManagedDriver } from "../managedDriver.js";
import type { AssistantDriver, StreamItem } from "../types.js";

const text = (value: string) => [{ type: "text" as const, text: value }];

describe("the managed driver", () => {
  let api: FakeManagedAgentsApi;
  let driver: AssistantDriver;
  let agentId: string;

  beforeEach(async () => {
    api = createFakeManagedAgentsApi();
    const provisioned = await provisionAssistant({
      client: api.client(),
      desired: buildAgentConfig({ model: "claude-haiku-5-5", effort: "low", knowledge: null }),
    });
    agentId = provisioned.agentId;
    driver = createManagedDriver({
      client: api.client(),
      agentId,
      environmentId: provisioned.environmentId,
    });
  });

  it("pins each session to the agent version current when the chat started", async () => {
    const first = await driver.createSession({ chatId: "chat-1", organizationId: "org-1" });
    await api.client().beta.agents.update(agentId, { system: "changed", version: 1 });
    const second = await driver.createSession({ chatId: "chat-2", organizationId: "org-1" });

    expect(first.agentVersion).toBe(1);
    expect(second.agentVersion).toBe(2);
    expect(api.sessions.get(first.sessionId)!.agent.version).toBe(1);
    expect(api.sessions.get(second.sessionId)!.agent.version).toBe(2);
  });

  it("sends the user message with the context last and answers the logged events", async () => {
    const { sessionId } = await driver.createSession({ chatId: "c", organizationId: "o" });

    const sent = await driver.sendEvents(sessionId, [
      { type: "user.message", content: text("How many days do I have left?") },
      { type: "system.message", content: text("Today: Monday 2026-11-09 (UTC).") },
    ]);

    expect(sent.map((event) => event.type)).toEqual(["user.message", "system.message"]);
    expect(sent.every((event) => event.id.startsWith("sevt_"))).toBe(true);
  });

  it("lists the events after one id, across pages, in order", async () => {
    const { sessionId } = await driver.createSession({ chatId: "c", organizationId: "o" });
    const [start] = await driver.sendEvents(sessionId, [
      { type: "user.message", content: text("hi") },
    ]);
    const message = api.emit(sessionId, { type: "agent.message", content: text("Hello") });
    const idle = api.emit(sessionId, {
      type: "session.status_idle",
      stop_reason: { type: "end_turn" },
    });

    const after = await driver.listEvents(sessionId, { afterId: start!.id });
    const all = await driver.listEvents(sessionId);

    expect(after.map((event) => event.id)).toEqual([message.id, idle.id]);
    expect(all).toHaveLength(3);
  });

  it("streams logged events and turns message deltas into text, attached before it says ready", async () => {
    const { sessionId } = await driver.createSession({ chatId: "c", organizationId: "o" });
    const controller = new AbortController();
    const live = driver.stream(sessionId, controller.signal);
    await live.ready;
    expect(api.openStreams(sessionId)).toBe(1);
    expect(api.calls.at(-1)!.path).toBe(`/v1/sessions/${sessionId}/events/stream`);

    api.streamOnly(sessionId, {
      type: "event_start",
      event: { type: "agent.message", id: "sevt_preview" },
    });
    api.streamOnly(sessionId, {
      type: "event_delta",
      event_id: "sevt_preview",
      delta: { type: "content_delta", index: 0, content: { type: "text", text: "Hel" } },
    });
    api.streamOnly(sessionId, {
      type: "event_delta",
      event_id: "sevt_preview",
      delta: { type: "content_delta", index: 0, content: { type: "text", text: "lo" } },
    });
    const message = api.emit(sessionId, { type: "agent.message", content: text("Hello") });
    api.emit(sessionId, { type: "session.status_idle", stop_reason: { type: "end_turn" } });

    const items: StreamItem[] = [];
    for await (const item of live) {
      items.push(item);
      if (item.kind === "event" && item.event.type === "session.status_idle") break;
    }
    controller.abort();

    expect(items).toEqual([
      { kind: "text_delta", text: "Hel" },
      { kind: "text_delta", text: "lo" },
      { kind: "event", event: message },
      { kind: "event", event: expect.objectContaining({ type: "session.status_idle" }) },
    ]);
  });

  it("stops streaming when the caller aborts", async () => {
    const { sessionId } = await driver.createSession({ chatId: "c", organizationId: "o" });
    const controller = new AbortController();
    const live = driver.stream(sessionId, controller.signal);
    await live.ready;

    const drained = (async () => {
      const items: StreamItem[] = [];
      for await (const item of live) items.push(item);
      return items;
    })();
    controller.abort();

    expect(await drained).toEqual([]);
  });

  it("answers a tool call with its result as text", async () => {
    const { sessionId } = await driver.createSession({ chatId: "c", organizationId: "o" });
    const call = api.emit(sessionId, {
      type: "agent.custom_tool_use",
      name: "get_my_balances",
      input: {},
    });

    const answer = await driver.answerToolCall(sessionId, String(call.id), {
      text: '{"buckets":[]}',
      isError: false,
    });

    expect(answer).toMatchObject({
      type: "user.custom_tool_result",
      custom_tool_use_id: call.id,
      content: text('{"buckets":[]}'),
      is_error: false,
    });
  });

  it("reads the session's cumulative usage with the cache split", async () => {
    const { sessionId } = await driver.createSession({ chatId: "c", organizationId: "o" });

    expect(await driver.readUsage(sessionId)).toEqual({
      input_tokens: 82,
      output_tokens: 253,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 7713, ephemeral_1h_input_tokens: 0 },
    });
  });

  it("deletes a session, and a session already gone is no error", async () => {
    const { sessionId } = await driver.createSession({ chatId: "c", organizationId: "o" });

    await driver.deleteSession(sessionId);
    await driver.deleteSession(sessionId);

    expect(api.sessions.has(sessionId)).toBe(false);
  });

  it("answers 503 when the API refuses", async () => {
    const error = await driver
      .sendEvents("sesn_missing", [{ type: "user.message", content: text("hi") }])
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).statusCode).toBe(503);
    expect((error as AppError).errors[0]!.publicContext).toEqual({ code: "ASSISTANT_UNAVAILABLE" });
  });
});
