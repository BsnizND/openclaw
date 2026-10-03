import type { MessageReactionSummary } from "../../packages/gateway-protocol/src/index.js";

export type CurrentSessionReactionInput = {
  messageId: string;
  emoji: string;
  remove?: boolean;
};
export type CurrentSessionReactionResult = {
  messageId: string;
  reactions: MessageReactionSummary[];
  changed: boolean;
};
/** Versioned required host authority, closed when its exact plugin invocation finishes. */
export type CurrentSessionReactionCapabilityV1 = Readonly<{
  version: 1;
  /** Genuine saved prompt ID; absent if the exact transcript admission is unavailable. */
  currentMessageId?: string;
  set: (input: CurrentSessionReactionInput) => Promise<CurrentSessionReactionResult>;
}>;
