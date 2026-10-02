import { expect, it, vi } from "vitest";
import {
  replaceSessionEntry,
  readSessionTranscriptMessageEvents,
} from "../../config/sessions/session-accessor.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import type { DeliverOutboundPayloadsCoreParams } from "./deliver-contracts.js";
import { mirrorDeliveredPayloads } from "./deliver-transcript.js";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn }),
}));
const fixture = useTempSessionsFixture("delivery-receipt-");
it("reuses a channel-committed transcript receipt while retaining separate messages", async () => {
  const sessionKey = "agent:main:receipt";
  const sessionId = "receipt-session";
  const cfg = { session: { store: fixture.storePath() } };
  const scope = { agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() };
  await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
  const first = await appendAssistantMessageToSessionTranscript({
    ...scope,
    text: "Minestra means soup.",
    idempotencyKey: "channel-delivery",
    config: cfg,
  });
  expect(first.ok).toBe(true);
  if (!first.ok) {
    throw new Error(first.reason);
  }
  await mirrorDeliveredPayloads({
    delivery: {
      cfg,
      mirror: {
        agentId: "main",
        sessionKey,
        expectedSessionId: sessionId,
        idempotencyKey: "message-tool-delivery",
      },
    } as DeliverOutboundPayloadsCoreParams,
    payloads: [{ text: "Minestra means soup.", mediaUrls: [] }],
    results: [
      {
        channel: "webchat",
        messageId: first.messageId,
        meta: {
          transcriptMessageId: first.messageId,
          transcriptSessionId: sessionId,
          transcriptSessionKey: sessionKey,
        },
      },
    ],
    channel: "webchat",
    to: sessionKey,
  });
  await appendAssistantMessageToSessionTranscript({
    ...scope,
    text: "The final answer is chickpea soup.",
    idempotencyKey: "final-reply",
    config: cfg,
  });
  const rows = readSessionTranscriptMessageEvents(scope);
  expect(rows).toHaveLength(2);
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ event: expect.objectContaining({ id: first.messageId }) }),
    ]),
  );
});

it.each(["missing-entry", "stale-session", "mismatched-message-id", "mixed-ownership"])(
  "refuses an invalid %s receipt without appending another delivered copy",
  async (failure) => {
    warn.mockClear();
    const sessionKey = "agent:main:receipt";
    const sessionId = "receipt-session";
    const cfg = { session: { store: fixture.storePath() } };
    const scope = { agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() };
    await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
    const saved = await appendAssistantMessageToSessionTranscript({
      ...scope,
      text: "Already delivered.",
      idempotencyKey: "destination",
      config: cfg,
    });
    if (!saved.ok) {
      throw new Error(saved.reason);
    }
    const receipt = {
      channel: "webchat",
      messageId: saved.messageId,
      meta: {
        transcriptMessageId: failure === "missing-entry" ? "absent" : saved.messageId,
        transcriptSessionId: failure === "stale-session" ? "previous-session" : sessionId,
        transcriptSessionKey: sessionKey,
      },
    };
    const results = [receipt];
    if (failure === "missing-entry") {
      receipt.messageId = "absent";
    }
    if (failure === "mismatched-message-id") {
      receipt.messageId = "different";
    }
    if (failure === "mixed-ownership") {
      results.push({
        channel: "webchat",
        messageId: "other",
        meta: {
          transcriptMessageId: "other",
          transcriptSessionId: sessionId,
          transcriptSessionKey: "agent:main:other",
        },
      });
    }
    await mirrorDeliveredPayloads({
      delivery: {
        cfg,
        mirror: {
          agentId: "main",
          sessionKey,
          expectedSessionId: sessionId,
          idempotencyKey: "core-mirror",
        },
      } as DeliverOutboundPayloadsCoreParams,
      payloads: [{ text: "Already delivered.", mediaUrls: [] }],
      results,
      channel: "webchat",
      to: sessionKey,
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(readSessionTranscriptMessageEvents(scope)).toHaveLength(1);
  },
);

it("keeps a source-session mirror for a delivery committed in another session", async () => {
  const sessionKey = "agent:main:source";
  const sessionId = "source-session";
  const cfg = { session: { store: fixture.storePath() } };
  const scope = { agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() };
  await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
  await mirrorDeliveredPayloads({
    delivery: {
      cfg,
      mirror: {
        agentId: "main",
        sessionKey,
        expectedSessionId: sessionId,
        idempotencyKey: "source-mirror",
      },
    } as DeliverOutboundPayloadsCoreParams,
    payloads: [{ text: "Delivered elsewhere.", mediaUrls: [] }],
    results: [
      {
        channel: "webchat",
        messageId: "destination-message",
        meta: {
          transcriptSessionKey: "agent:main:destination",
          transcriptSessionId: "destination-session",
          transcriptMessageId: "destination-message",
        },
      },
    ],
    channel: "webchat",
    to: "agent:main:destination",
  });
  expect(readSessionTranscriptMessageEvents(scope)).toHaveLength(1);
});
