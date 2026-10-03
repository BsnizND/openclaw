import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { createNativeSessionReactionCompletion } from "../../sessions/reaction-completion.js";

/** Called only inside the accepted final current-source delivery boundary. */
export function recordMessageToolReactionCompletion(
  action: string,
  details: unknown,
  runId: string | undefined,
) {
  if (action !== "react") {
    return undefined;
  }
  const receipt = asOptionalRecord(asOptionalRecord(details)?.nativeSessionReaction);
  if (!receipt || !runId) {
    return undefined;
  }
  const completion = createNativeSessionReactionCompletion(receipt, runId);
  const run = getAgentRunContext(runId);
  if (
    run?.sessionId === completion.sessionId &&
    run.sessionKey === completion.sessionKey &&
    run.agentId === completion.agentId
  ) {
    run.nativeSessionReactionCompletion = completion;
  }
  return completion;
}
