// Mirrors successful outbound payloads into the configured session transcript.
import { resolveMirroredTranscriptText } from "../../config/sessions/transcript-mirror.js";
import { getOwnedSessionTranscriptWriterFence } from "../../config/sessions/transcript-write-context.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { formatErrorMessage } from "../errors.js";
import type { DeliverOutboundPayloadsCoreParams } from "./deliver-contracts.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";
import { resolveOutboundPayloadMirrorText, type NormalizedOutboundPayload } from "./payloads.js";

const log = createSubsystemLogger("outbound/deliver");
const loadTranscriptRuntime = createLazyRuntimeModule(
  () => import("../../config/sessions/transcript.runtime.js"),
);

export async function mirrorDeliveredPayloads(params: {
  delivery: DeliverOutboundPayloadsCoreParams;
  payloads: readonly NormalizedOutboundPayload[];
  results?: readonly OutboundDeliveryResult[];
  channel: string;
  to: string;
}): Promise<void> {
  const mirror = params.delivery.mirror;
  if (!mirror || params.payloads.length === 0) {
    return;
  }
  const deliveredMirror = {
    text: params.payloads
      .map((payload) => payload.hookContent ?? resolveOutboundPayloadMirrorText(payload))
      .filter((text) => text.trim())
      .join("\n"),
    mediaUrls: params.payloads.flatMap((payload) => payload.mediaUrls),
  };
  const mirrorText = resolveMirroredTranscriptText({
    text: deliveredMirror.text,
    mediaUrls: deliveredMirror.mediaUrls,
  });
  if (!mirrorText) {
    return;
  }
  // Transcript mirroring is best-effort bookkeeping after platform send.
  // Keep mirror failures non-fatal so callers do not retry an already-sent payload.
  try {
    const results = params.results ?? [];
    const committed = results.filter(
      (result) => result.meta?.transcriptSessionKey === mirror.sessionKey,
    );
    if (committed.length > 0) {
      // A transcript-backed destination has already committed the visible send.
      // Verify its exact native identity, rather than deduplicating equal prose.
      if (committed.length !== results.length) {
        throw new Error("Mixed transcript ownership in outbound delivery receipt");
      }
      const [accessor, paths] = await Promise.all([
        import("../../config/sessions/session-accessor.js"),
        import("../../config/sessions/paths.js"),
      ]);
      const agentId = mirror.agentId ?? resolveAgentIdFromSessionKey(mirror.sessionKey);
      const storePath = paths.resolveSessionStorePathCore(params.delivery.cfg.session?.store, {
        agentId,
      });
      const scope = { agentId, sessionKey: mirror.sessionKey, storePath };
      const entry = accessor.loadSessionEntryReadOnly(scope);
      for (const result of committed) {
        const sessionId = result.meta?.transcriptSessionId;
        const entryId = result.meta?.transcriptMessageId;
        if (
          typeof sessionId !== "string" ||
          typeof entryId !== "string" ||
          entryId !== result.messageId ||
          entry?.sessionId !== sessionId ||
          (mirror.expectedSessionId && mirror.expectedSessionId !== sessionId)
        ) {
          throw new Error("Outbound transcript receipt identity mismatch");
        }
        const anchor = accessor.readActiveTranscriptEntryAnchor({ ...scope, sessionId, entryId });
        if (!anchor || anchor.sessionKey !== mirror.sessionKey) {
          throw new Error("Outbound transcript receipt is not on the active native path");
        }
        const row = accessor.readSessionTranscriptMessageEventPage(
          { ...scope, sessionId },
          {
            maxMessages: 1,
            offset: anchor.activeMessagePosition,
            offsetFrom: "start",
            readOnly: true,
          },
        ).events[0]?.event;
        if (
          !row ||
          typeof row !== "object" ||
          !("id" in row) ||
          !("message" in row) ||
          row.id !== entryId ||
          !row.message ||
          typeof row.message !== "object" ||
          !("role" in row.message) ||
          row.message.role !== "assistant"
        ) {
          throw new Error("Outbound transcript receipt does not identify an assistant message");
        }
      }
      return;
    }
    const { appendAssistantMessageToSessionTranscript } = await loadTranscriptRuntime();
    // Fence against the session this mirror lands in, not whichever run is delivering:
    // a cross-session delivery would otherwise carry the sending run's writer claim.
    const writerFence = getOwnedSessionTranscriptWriterFence({ sessionKey: mirror.sessionKey });
    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      agentId: mirror.agentId,
      sessionKey: mirror.sessionKey,
      expectedSessionId: mirror.expectedSessionId,
      ...(writerFence?.expectedLifecycleRevision !== undefined
        ? { expectedLifecycleRevision: writerFence.expectedLifecycleRevision }
        : {}),
      ...(writerFence ? { expectedWriterRunId: writerFence.expectedWriterRunId } : {}),
      text: mirrorText,
      idempotencyKey: mirror.idempotencyKey,
      deliveryMirror: mirror.deliveryMirror,
      config: params.delivery.cfg,
    });
    if (!mirrorResult.ok) {
      log.warn(
        `failed to mirror outbound delivery into session transcript; channel send already succeeded: ${mirrorResult.reason}`,
        { channel: params.channel, to: params.to, sessionKey: mirror.sessionKey },
      );
    }
  } catch (err) {
    log.warn(
      `failed to mirror outbound delivery into session transcript; channel send already succeeded: ${formatErrorMessage(err)}`,
      { channel: params.channel, to: params.to, sessionKey: mirror.sessionKey },
    );
  }
}
