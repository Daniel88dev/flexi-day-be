# Assistant chats: closing and deleting

A chat's display record (`assistant_chats`, `assistant_chat_messages`, its cards in
`assistant_pending_actions` and held answers) is ours and the authority for retention. The
Anthropic session is the model's memory and is deleted on our schedule. The code is
`src/services/assistant/chatLifecycle.ts`.

## Closed chats

A chat closes, and stays readable, when either holds:

- **Length**: `context_tokens` reaches `ASSISTANT_CHAT_TOKEN_CEILING` (100,000 by default, set
  below the harness's compaction threshold by the T-711 spike). `advanceTurn` writes
  `context_tokens` at each idle from the session's latest settled step: input, both cache writes,
  cache reads and output.
- **Idle**: 30 days passed since `last_message_at`.

Every chat answer carries `closed`: `length`, `idle` or `null`; length wins when both hold. A send
to a closed chat answers 409 `ASSISTANT_CHAT_CLOSED` with the `reason` and writes nothing. A card
decision in an idle-closed chat answers the same 409, since its session is gone; a length-closed
chat still settles the cards of the turn that closed it.

A plan lapse or the owner turning the Assistant off refuses new messages (403
`AI_ORGANIZATION_NOT_ELIGIBLE` with the reason) and leaves every chat readable.
`GET /api/assistant/organizations` answers `hasChats` per organization, so the panel still opens for
someone whose only chats are in such an organization.

## The nightly tick

`runAssistantChatRetention` (`src/jobs/assistantChatRetentionJob.ts`) runs last on the quota
rollover tick:

1. **Day 30.** Every chat whose last message is 30 days old and still has a session: the session is
   queued for deletion, `session_id` cleared, open cards marked `not_taken`, held answers dropped,
   and a stuck turn freed.
2. **Day 180.** Every chat whose last message is 180 days old is deleted with its display record,
   cards and held answers, and the rejected turns tied to it go too.
3. **Drain.** Every queued session is deleted through the driver.

## The session deletion queue

Every chat delete and the day-30 close write the session id into `assistant_session_deletions` in
the same transaction. After the HTTP response, when that transaction has committed, the request's
sessions are deleted through the driver (`src/middleware/sessionDeletionDrain.ts`); a row goes once
the driver confirms, and a failure counts an attempt and waits for the nightly drain. The managed
driver interrupts a running session before it deletes it, and a session already gone counts as
deleted.

## Leaving an organization

A member's chats in an organization, with their cards and sessions, go at once when they:

- lose the last of the four links (`syncEmployment`'s no-link branch, in a Directory organization
  too): removed from their last group, admin grant revoked, their group deleted;
- leave through End employment;
- delete their account (every chat, in every organization);
- are erased.

Their rejected-turn counts and ledger rows stay with no chat, like the rest of their Usage.

## Deleting an organization

An organization deleted with its owner's account takes every chat in it, anyone's, and queues their
sessions first, since the cascade from `organizations` would leave the session ids nowhere.
