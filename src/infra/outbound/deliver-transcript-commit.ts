// Verifies persist-before-notify receipts without trusting source payload metadata.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";
import type { NormalizedOutboundPayload } from "./payloads.js";

const log = createSubsystemLogger("outbound/deliver");
const loadSessionAccessor = createLazyRuntimeModule(
  () => import("../../config/sessions/session-accessor.js"),
);
const loadHistoryReader = createLazyRuntimeModule(
  () => import("../../config/sessions/session-accessor.sqlite-history-events.js"),
);

/** Verified native transcript identity covering a complete successful logical payload. */
export type DeliveredTranscriptCommit = {
  conversationId: string;
  sessionId: string;
  messageIds: string[];
};

/** Every send must identify a visible assistant entry in the exact active native destination. */
export async function resolveDeliveredTranscriptCommit(params: {
  cfg: OpenClawConfig;
  results: readonly OutboundDeliveryResult[];
  channel: string;
  to: string;
}): Promise<DeliveredTranscriptCommit | undefined> {
  if (!params.results.some((result) => result.meta?.transcriptMessageId !== undefined)) {
    return undefined;
  }
  const reject = (): undefined => {
    log.warn("Ignoring unverified native transcript commit; preserving delivery mirror", {
      channel: params.channel,
    });
    return undefined;
  };
  try {
    const sessionId = params.results[0]?.meta?.transcriptSessionId;
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      return reject();
    }
    const messageIds: string[] = [];
    for (const result of params.results) {
      const messageId = result.meta?.transcriptMessageId;
      if (
        result.channel !== params.channel ||
        result.conversationId !== params.to ||
        result.meta?.transcriptSessionId !== sessionId ||
        typeof messageId !== "string" ||
        !messageId.trim() ||
        messageIds.includes(messageId)
      ) {
        return reject();
      }
      messageIds.push(messageId);
    }
    const {
      bindSessionTranscriptStoreScope,
      loadExactSessionEntryReadOnly,
      readActiveTranscriptEntryAnchor,
    } = await loadSessionAccessor();
    const { readSessionTranscriptHistoryEventById } = await loadHistoryReader();
    const scope = bindSessionTranscriptStoreScope({ sessionKey: params.to, sessionId }, params.cfg);
    const exact = loadExactSessionEntryReadOnly(scope);
    if (exact?.entry.sessionId !== sessionId) {
      return reject();
    }
    for (const entryId of messageIds) {
      const event = readSessionTranscriptHistoryEventById(scope, entryId)?.event;
      if (
        !isRecord(event) ||
        !isRecord(event.message) ||
        event.message.role !== "assistant" ||
        !readActiveTranscriptEntryAnchor({ ...scope, entryId })
      ) {
        return reject();
      }
    }
    return { conversationId: params.to, sessionId, messageIds };
  } catch {
    // Verification follows delivery; reader failures must never trigger another send.
    return reject();
  }
}

/** Receipt evidence applies only to the exact destination, never other-session awareness. */
export function isTranscriptCommittedForSession(
  payload: NormalizedOutboundPayload,
  sessionKey: string | undefined,
  sessionId?: string,
): boolean {
  return Boolean(
    sessionKey &&
    payload.transcriptCommit?.conversationId === sessionKey &&
    (sessionId === undefined || payload.transcriptCommit.sessionId === sessionId),
  );
}
