import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
/** Host-proven completed current-prompt reaction; execution correlation may differ from chat. */
export const NativeSessionReactionCompletionSchema = closedObject({
  runId: NonEmptyString,
  executionRunId: Type.Optional(NonEmptyString),
  sourceIdempotencyKey: Type.Optional(NonEmptyString),
  sessionKey: NonEmptyString,
  agentId: NonEmptyString,
  sessionId: NonEmptyString,
  messageId: NonEmptyString,
  emoji: Type.String({ minLength: 1, maxLength: 32 }),
  actor: closedObject({
    type: Type.Literal("agent"),
    id: NonEmptyString,
    label: Type.Optional(Type.String()),
  }),
});
export type NativeSessionReactionCompletion = Static<typeof NativeSessionReactionCompletionSchema>;
