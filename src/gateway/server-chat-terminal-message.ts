import { getAgentRunContext } from "../infra/agent-run-registry.js";
import { appendChatCanvasBlocksToMessage } from "./chat-display-projection.canvas.js";

export function createTerminalChatMessage(
  text: string,
  runId: string,
  assistantTranscriptIdempotencyKey?: string,
) {
  return (canvasBlocks: Parameters<typeof appendChatCanvasBlocksToMessage>[1]) =>
    appendChatCanvasBlocksToMessage(
      {
        role: "assistant",
        content: text ? [{ type: "text", text }] : [],
        timestamp: Date.now(),
        ...(assistantTranscriptIdempotencyKey
          ? { __openclaw: { runId, idempotencyKey: assistantTranscriptIdempotencyKey } }
          : {}),
      },
      canvasBlocks,
    );
}

/** Presentation of the same host-accepted delivery fact; chat-link owns client correlation. */
export function projectNativeReactionChatCompletion(params: {
  jobState: "done" | "error" | "aborted";
  sessionKey: string;
  clientRunId: string;
  sourceRunId: string;
  agentId?: string;
}) {
  const run = getAgentRunContext(params.sourceRunId);
  const completion = run?.nativeSessionReactionCompletion;
  if (
    params.jobState !== "done" ||
    !completion ||
    completion.sessionKey !== params.sessionKey ||
    completion.agentId !== params.agentId ||
    completion.sessionId !== run?.sessionId ||
    (completion.executionRunId ?? completion.runId) !== params.sourceRunId
  ) {
    return {};
  }
  const { executionRunId: _previousExecutionRunId, ...fact } = completion;
  return {
    nativeSessionReactionCompletion: {
      ...fact,
      runId: params.clientRunId,
      ...(params.sourceRunId !== params.clientRunId ? { executionRunId: params.sourceRunId } : {}),
    },
  };
}
