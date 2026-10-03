import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isReactionEmoji,
  type NativeSessionReactionCompletion,
} from "../../packages/gateway-protocol/src/index.js";

// Operational IDs are bounded so this fact survives the native tool-details byte cap.
function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}
function readNativeSessionReactionCompletion(
  value: unknown,
): NativeSessionReactionCompletion | undefined {
  const fact = asOptionalRecord(value);
  const actor = asOptionalRecord(fact?.actor);
  if (!fact || !actor) {
    return undefined;
  }
  const {
    runId,
    sessionKey,
    agentId,
    sessionId,
    messageId,
    emoji,
    executionRunId,
    sourceIdempotencyKey,
  } = fact;
  const { id, label } = actor;
  if (
    actor.type !== "agent" ||
    !boundedId(runId) ||
    !boundedId(sessionKey) ||
    !boundedId(agentId) ||
    !boundedId(sessionId) ||
    !boundedId(messageId) ||
    !boundedId(id) ||
    id !== `agent:${agentId}` ||
    typeof emoji !== "string" ||
    !isReactionEmoji(emoji) ||
    (executionRunId !== undefined && !boundedId(executionRunId)) ||
    (sourceIdempotencyKey !== undefined && !boundedId(sourceIdempotencyKey)) ||
    (label !== undefined && (typeof label !== "string" || label.length > 200))
  ) {
    return undefined;
  }
  return {
    runId,
    sessionKey,
    agentId,
    sessionId,
    messageId,
    emoji,
    ...(executionRunId ? { executionRunId } : {}),
    ...(sourceIdempotencyKey ? { sourceIdempotencyKey } : {}),
    actor: { type: "agent", id, ...(label ? { label } : {}) },
  };
}
/** Called only after the existing native source-reply owner accepts a final current-prompt add. */
export function createNativeSessionReactionCompletion(
  receiptValue: unknown,
  executionRunId: string,
): NativeSessionReactionCompletion {
  const receipt = asOptionalRecord(receiptValue);
  if (!receipt) {
    throw new Error("Native reaction completion requires its committed host receipt");
  }
  const sourceKey =
    typeof receipt.sourceIdempotencyKey === "string" ? receipt.sourceIdempotencyKey : undefined;
  // This suffix is the native gateway user-admission producer's exact contract, not text matching.
  const sourceRunId = sourceKey?.endsWith(":user") ? sourceKey.slice(0, -5) : undefined;
  const fact = readNativeSessionReactionCompletion({
    ...receipt,
    runId: sourceRunId || executionRunId,
    ...(sourceRunId && sourceRunId !== executionRunId ? { executionRunId } : {}),
  });
  if (!fact) {
    throw new Error("Native reaction completion identity exceeds the supported receipt bounds");
  }
  return fact;
}
/** Only persisted host message-delivery facts qualify, never an adapter reaction event. */
export function readPersistedReactionCompletion(
  details: unknown,
): NativeSessionReactionCompletion | undefined {
  const delivery = asOptionalRecord(asOptionalRecord(details)?.messageDelivery);
  return delivery?.status === "settled" &&
    delivery.sourceReplyDelivered === true &&
    delivery.partialDelivery === false
    ? readNativeSessionReactionCompletion(delivery.nativeSessionReactionCompletion)
    : undefined;
}
