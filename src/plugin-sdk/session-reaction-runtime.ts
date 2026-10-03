import type { ChannelMessageActionContext } from "../channels/plugins/types.core.js";
import type {
  CurrentSessionReactionInput,
  CurrentSessionReactionResult,
} from "../sessions/reaction-action.types.js";
export type {
  CurrentSessionReactionCapabilityV1,
  CurrentSessionReactionInput,
  CurrentSessionReactionResult,
} from "../sessions/reaction-action.types.js";
export { isReactionEmoji } from "../../packages/gateway-protocol/src/index.js";
export type { MessageReactionSummary } from "../../packages/gateway-protocol/src/index.js";

/** Writes only through the current invocation's host-bound agent authority. */
export async function reactToCurrentSessionMessage(
  context: ChannelMessageActionContext,
  input: CurrentSessionReactionInput,
): Promise<CurrentSessionReactionResult> {
  if (!context.sessionReactions || context.sessionReactions.version !== 1) {
    throw new Error("Native current-turn session reactions are unavailable for this action");
  }
  return context.sessionReactions.set(input);
}
