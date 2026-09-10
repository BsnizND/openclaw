// Validates complete all-image receipts from native session-key-addressed transports.
import path from "node:path";
import type { ChannelMessageTranscriptMedia } from "../../channels/message/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";
import type { NormalizedOutboundPayload } from "./payloads.js";

const log = createSubsystemLogger("outbound/deliver");
const loadMediaStore = createLazyRuntimeModule(() => import("../../media/store.js"));

/** Complete ordered all-image projection for one successfully delivered native payload. */
export type DeliveredTranscriptMedia = {
  conversationId: string;
  media: ChannelMessageTranscriptMedia[];
};

function readImageFact(value: unknown): ChannelMessageTranscriptMedia | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  // SAFETY: The guard above establishes a non-null, non-array object; every field is checked below.
  const fact = value as Record<string, unknown>;
  if (
    fact.kind !== "image" ||
    typeof fact.path !== "string" ||
    !path.isAbsolute(fact.path) ||
    typeof fact.contentType !== "string" ||
    !/^image\/[a-z0-9][a-z0-9.+-]*$/u.test(fact.contentType)
  ) {
    return undefined;
  }
  return { path: fact.path, contentType: fact.contentType, kind: "image" };
}

/** External route ids and incomplete or mixed-attachment facts retain filename projection. */
export async function resolveDeliveredTranscriptMedia(params: {
  payload: NormalizedOutboundPayload;
  results: readonly OutboundDeliveryResult[];
  channel: string;
  to: string;
}): Promise<DeliveredTranscriptMedia | undefined> {
  const reject = (): undefined => {
    log.warn("Ignoring invalid native transcript media from channel send; preserving text mirror", {
      channel: params.channel,
    });
    return undefined;
  };
  try {
    if (!params.results.some((result) => result.meta?.transcriptMedia !== undefined)) {
      return undefined;
    }
    const media: ChannelMessageTranscriptMedia[] = [];
    for (const result of params.results) {
      const declared: unknown = result.meta?.transcriptMedia;
      if (
        result.channel !== params.channel ||
        result.conversationId !== params.to ||
        !Array.isArray(declared) ||
        declared.length === 0 ||
        declared.length > params.payload.mediaUrls.length
      ) {
        return reject();
      }
      for (const value of declared) {
        const fact = readImageFact(value);
        if (!fact) {
          return reject();
        }
        media.push(fact);
      }
    }
    // This opt-in supports complete all-image payloads only. Partial image facts in
    // mixed-attachment payloads cannot identify which filename fallbacks they replace.
    if (media.length === 0 || media.length !== params.payload.mediaUrls.length) {
      return reject();
    }
    const { getMediaDir, resolveMediaBufferPath } = await loadMediaStore();
    for (const fact of media) {
      const relative = path.relative(getMediaDir(), fact.path);
      if (
        !relative ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        return reject();
      }
      const subdir = path.dirname(relative);
      // The native resolver checks containment, symlinks, and regular-file identity.
      // It opens/closes the file without reading bytes or creating another asset.
      fact.path = await resolveMediaBufferPath(
        path.basename(relative),
        subdir === "." ? "" : subdir,
      );
    }
    return { conversationId: params.to, media };
  } catch {
    return reject();
  }
}

/** Only transports addressed by the exact native session key project images into that mirror. */
export function transcriptMediaForSession(
  payload: NormalizedOutboundPayload,
  sessionKey: string | undefined,
): readonly ChannelMessageTranscriptMedia[] {
  return sessionKey && payload.transcriptMedia?.conversationId === sessionKey
    ? payload.transcriptMedia.media
    : [];
}
