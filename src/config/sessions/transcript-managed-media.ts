import path from "node:path";
import type { PreparedOutgoingMedia } from "../../gateway/managed-image-attachments.js";
import type { MediaFact } from "../../media/media-facts.js";
import { getMediaDir } from "../../media/store.js";
import {
  ASSISTANT_DISPLAY_CONTENT_FIELD,
  readAssistantDisplayContent,
} from "../../shared/assistant-display-content.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import { findTranscriptEvent, readTranscriptEventMessage } from "./session-accessor.sqlite-read.js";
import type { SessionTranscriptTurnPersistOptions } from "./session-accessor.types.js";
import type { SessionTranscriptAssistantMessage } from "./transcript.js";

const loadManagedMedia = createLazyRuntimeModule(
  () => import("../../gateway/managed-image-attachments.js"),
);

/** Stages display assets inside the native writer and binds them before publication. */
export function createTranscriptManagedMedia(params: {
  message: SessionTranscriptAssistantMessage;
  media: readonly MediaFact[];
  target: SessionTranscriptReadScope & { sessionKey: string };
  idempotencyKey?: string;
}) {
  const items: PreparedOutgoingMedia[] = [];
  for (const fact of params.media) {
    if (
      fact.kind !== "image" ||
      !fact.path ||
      !path.isAbsolute(fact.path) ||
      !fact.contentType ||
      !/^image\/[a-z0-9][a-z0-9.+-]*$/u.test(fact.contentType)
    ) {
      return undefined;
    }
    const relative = path.relative(getMediaDir(), fact.path);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return undefined;
    }
    items.push({ url: fact.path, mimeType: fact.contentType, trustedLocal: false });
  }
  if (!items.length) {
    return undefined;
  }
  let runtime: Awaited<ReturnType<typeof loadManagedMedia>> | undefined;
  let preparedBlocks: Record<string, unknown>[] = [];
  let committed = false;
  return {
    async prepare() {
      runtime = await loadManagedMedia();
      const prior = params.idempotencyKey
        ? await findTranscriptEvent(
            params.target,
            (event) => readTranscriptEventMessage(event)?.idempotencyKey === params.idempotencyKey,
          )
        : undefined;
      if (prior) {
        const priorMessage = readTranscriptEventMessage(prior.event);
        if (Array.isArray(priorMessage?.[ASSISTANT_DISPLAY_CONTENT_FIELD])) {
          // Reuse only generated display identities. The current caption and media
          // facts still undergo the native exact idempotency comparison.
          params.message[ASSISTANT_DISPLAY_CONTENT_FIELD] =
            readAssistantDisplayContent(priorMessage);
        }
        return;
      }
      try {
        preparedBlocks = await runtime.createManagedOutgoingMediaBlocks({
          sessionKey: params.target.sessionKey,
          agentId: params.target.agentId,
          items,
          localRoots: [getMediaDir()],
        });
      } catch {
        // The managed owner removes partial assets before rejecting preparation.
        // Preserve the original transcript candidate when display media cannot be prepared.
        return;
      }
      params.message[ASSISTANT_DISPLAY_CONTENT_FIELD] = [
        ...readAssistantDisplayContent(params.message),
        ...preparedBlocks,
      ];
    },
    onCommitted: ((result) => {
      // The transcript owns newly appended assets even if promotion or a later
      // publication callback throws. A replay can retry that same promotion.
      committed = result.appended;
      const blocks = readAssistantDisplayContent(result.message);
      const hasManagedMedia = blocks.some(
        (block) =>
          typeof block.url === "string" && block.url.startsWith("/api/chat/media/outgoing/"),
      );
      if (
        hasManagedMedia &&
        !runtime?.attachManagedOutgoingMediaToMessage({ messageId: result.messageId, blocks })
      ) {
        throw new Error("Failed to bind transcript managed media to its committed message");
      }
    }) satisfies NonNullable<SessionTranscriptTurnPersistOptions["onMessageCommitted"]>,
    async cleanup() {
      if (!committed && preparedBlocks.length) {
        await runtime?.removeManagedOutgoingMediaBlocks({
          blocks: preparedBlocks,
          messageId: null,
        });
      }
    },
  };
}
