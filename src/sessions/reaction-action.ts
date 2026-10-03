import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isReactionEmoji } from "../../packages/gateway-protocol/src/index.js";
import { resolveAgentIdentity } from "../agents/identity.js";
import type { ChannelMessageActionContext } from "../channels/plugins/types.core.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { setSessionReactionAsync } from "../config/sessions/session-reaction-store.js";
import { readSessionMessageByIdAsync } from "../gateway/session-transcript-readers.js";
import type { CurrentSessionReactionCapabilityV1 } from "./reaction-action.types.js";
import { publishSessionReaction } from "./reaction-events.js";

export type CommittedSessionReaction = Readonly<{
  agentId: string;
  sessionKey: string;
  sessionId: string;
  messageId: string;
  emoji: string;
  actor: { type: "agent"; id: string; label?: string };
  sourceIdempotencyKey?: string;
  changed: boolean;
  remove: boolean;
}>;

/** Host-only binding. Plugins receive the closure, never authority construction inputs. */
export function bindCurrentSessionReaction(params: {
  context: ChannelMessageActionContext;
  assertCurrentTurn: () => void;
  assertPluginCurrent: () => void;
  currentMessageId?: string;
}): {
  capability: CurrentSessionReactionCapabilityV1;
  close: () => void;
  readCommittedReaction: () => CommittedSessionReaction | undefined;
} {
  const { context } = params;
  const { cfg, agentId, sessionKey, sessionId } = context;
  if (
    !agentId ||
    !sessionKey ||
    !sessionId ||
    context.action !== "react" ||
    context.conversationReadOrigin === "direct-operator" ||
    context.dryRun
  ) {
    throw new Error("Native reactions require an admitted current agent session");
  }
  const onDispatch = context.onPlatformSendDispatch;
  const assertHandoff = context.assertDirectAdapterHandoff;
  const scope = {
    agentId,
    sessionKey,
    storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }),
  };
  const actor = {
    type: "agent" as const,
    id: `agent:${agentId}`,
    label: resolveAgentIdentity(cfg, agentId)?.name?.trim() || agentId,
  };
  let active = true;
  let committedReaction: CommittedSessionReaction | undefined;
  const assertCurrent = () => {
    if (!active) {
      throw new Error("Native reaction invocation is closed");
    }
    params.assertCurrentTurn();
    params.assertPluginCurrent();
    assertHandoff?.();
  };
  return {
    close: () => {
      active = false;
    },
    readCommittedReaction: () => committedReaction,
    capability: Object.freeze({
      version: 1 as const,
      currentMessageId: params.currentMessageId,
      async set(input) {
        assertCurrent();
        const messageId = normalizeOptionalString(input.messageId);
        const { emoji, remove } = input;
        if (
          !messageId ||
          !isReactionEmoji(emoji) ||
          (remove !== undefined && typeof remove !== "boolean")
        ) {
          throw new Error("A canonical message ID and one emoji grapheme are required");
        }
        const message = asOptionalRecord(
          (
            await readSessionMessageByIdAsync({ ...scope, sessionId }, messageId, {
              currentOnly: true,
              maxBytes: Number.MAX_SAFE_INTEGER,
              allowResetArchiveFallback: false,
            })
          ).message,
        );
        assertCurrent();
        if (!message || (message.role !== "user" && message.role !== "assistant")) {
          throw new Error("Unknown saved message in the current session");
        }
        await onDispatch?.();
        assertCurrent();
        const write = await setSessionReactionAsync(scope, {
          messageId,
          emoji,
          remove,
          identityId: actor.id,
          identityLabel: actor.label,
          expectedSessionId: sessionId,
          assertCurrent,
        });
        committedReaction = Object.freeze({
          agentId,
          sessionKey,
          sessionId,
          messageId,
          emoji,
          actor,
          sourceIdempotencyKey: normalizeOptionalString(message.idempotencyKey),
          changed: write.changed,
          remove: remove === true,
        });
        // Publish committed side data. Agent reactions neither enqueue a human notice nor mirror.
        if (write.changed) {
          publishSessionReaction({
            sessionKey,
            agentId,
            sessionId,
            messageId,
            emoji,
            action: remove ? "removed" : "added",
            actor,
            reactions: write.reactions,
          });
        }
        return { messageId, reactions: write.reactions, changed: write.changed };
      },
    }),
  };
}
