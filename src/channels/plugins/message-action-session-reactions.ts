import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentToolResult } from "../../agents/runtime/index.js";
import type { MessageActionAuthorization } from "../../gateway/message-action-turn-capability.js";
import { extractToolPayload } from "../../plugin-sdk/tool-payload.js";
import { normalizeConversationReadInvocationOrigin } from "./conversation-read-origin.js";
import type { ChannelMessageActionContext, ChannelPlugin } from "./types.js";

type NativeReactionDispatchContext = Omit<ChannelMessageActionContext, "action"> & {
  action: unknown;
  messageActionAuthorization?: MessageActionAuthorization;
};

export function isNativeSessionReaction(
  prepared: { actionContext: ChannelMessageActionContext; plugin: ChannelPlugin } | undefined,
): boolean {
  return (
    prepared?.actionContext.action === "react" &&
    prepared.plugin.capabilities.nativeSessionReactions === true
  );
}

export function assertNativeReactionTurn(ctx: NativeReactionDispatchContext): void {
  const { agentId, sessionKey, sessionId } = ctx;
  if (
    !agentId ||
    !sessionKey ||
    !sessionId ||
    ctx.dryRun ||
    ctx.messageActionAuthorization?.scheduled ||
    !ctx.messageActionAuthorization?.assertCurrentTurn ||
    normalizeConversationReadInvocationOrigin(ctx.conversationReadOrigin) === "direct-operator"
  ) {
    throw new Error("Native session reactions require current-turn authority");
  }
  if (
    [
      "target",
      "to",
      "channelId",
      "chatId",
      "chatGuid",
      "chatIdentifier",
      "threadId",
      "messageThreadId",
    ].some(
      (key) => ctx.params[key] !== undefined && ctx.params[key] !== null && ctx.params[key] !== "",
    )
  ) {
    throw new Error("Native session reactions target the current session; omit platform targets");
  }
  ctx.messageActionAuthorization.assertCurrentTurn({ agentId, sessionKey, sessionId });
  ctx.messageActionAuthorization.assertDashboardReadCurrent?.();
}

/** Reserved native receipt is always stamped or removed by the host dispatch boundary. */
export function stampNativeReactionResult(
  result: AgentToolResult<unknown>,
  receipt?: import("../../sessions/reaction-action.js").CommittedSessionReaction,
): AgentToolResult<unknown> {
  const payload = asOptionalRecord(extractToolPayload(result));
  if (!payload && !receipt) {
    return result;
  }
  const { nativeSessionReaction: _untrusted, ...details } = payload ?? {};
  return {
    ...result,
    details: { ...details, ...(receipt ? { nativeSessionReaction: receipt } : {}) },
  };
}

/** Bind one plugin invocation to the live native session owner and its committed receipt. */
export async function dispatchNativeSessionReaction(params: {
  context: ChannelMessageActionContext;
  authorization?: MessageActionAuthorization;
  assertPluginCurrent: () => void;
  handleAction: (context: ChannelMessageActionContext) => Promise<AgentToolResult<unknown>>;
}): Promise<AgentToolResult<unknown>> {
  const { context, authorization } = params;
  assertNativeReactionTurn({ ...context, messageActionAuthorization: authorization });
  const assertCurrentTurn = authorization!.assertCurrentTurn!;
  const reactionOwner = {
    agentId: context.agentId!,
    sessionKey: context.sessionKey!,
    sessionId: context.sessionId!,
  };
  const { bindCurrentSessionReaction } = await import("../../sessions/reaction-action.js");
  const binding = bindCurrentSessionReaction({
    context,
    currentMessageId: authorization!.currentSessionMessageId,
    assertCurrentTurn: () => assertCurrentTurn(reactionOwner),
    assertPluginCurrent: params.assertPluginCurrent,
  });
  try {
    const result = await params.handleAction({ ...context, sessionReactions: binding.capability });
    // The host stamps durable evidence; plugin payloads cannot invent it.
    return stampNativeReactionResult(result, binding.readCommittedReaction());
  } finally {
    binding.close();
  }
}
