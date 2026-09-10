import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundContext } from "../../channels/plugins/outbound.types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import {
  appendAdmittedDirectCronDeliveryTranscriptMirror,
  projectDeliveredDirectCronPayloadsForMirror,
  resolveDirectCronTranscriptMirrorText,
} from "../../cron/isolated-agent/delivery-dispatch-awareness.js";
import type { CronJob } from "../../cron/types.js";
import { readPersistedMediaFacts } from "../../media/media-facts.js";
import { saveMediaBuffer } from "../../media/store.js";
import { readVisibleSessionTranscriptMessageEntries } from "../../plugin-sdk/session-transcript-runtime.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";
import type { NormalizedOutboundPayload } from "./payloads.js";
import { createUnmodifiedPreparedOutboundBatch } from "./prepared-batch.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6j0AAAAASUVORK5CYII=",
  "base64",
);
const sessionKey = "agent:main:matrix:dm:transcript-fixture";
const sessionId = "transcript-fixture-session";
let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;
let deliverOutboundPayloadsCore: typeof import("./deliver-core.js").deliverOutboundPayloadsCore;

describe("native outbound transcript image projection", () => {
  const fixture = useTempSessionsFixture("outbound-transcript-media-");
  let cfg: OpenClawConfig;
  let imagePath: string;
  let receiptConversation: string;
  let receiptMedia: unknown;
  let mediaWithoutImageFacts: string | undefined;
  let rejectBeforeDispatchForMedia: string | undefined;
  let mediaAttempts: ChannelOutboundContext[];
  let failMedia = false;
  let transportSawMessageCount = -1;

  const scope = () => ({ agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() });
  const messages = async () => readVisibleSessionTranscriptMessageEntries(scope());

  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
    ({ deliverOutboundPayloadsCore } = await import("./deliver-core.js"));
  });

  beforeEach(async () => {
    const stateDir = path.resolve(fixture.sessionsDir(), "../../..");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    cfg = { session: { store: fixture.storePath() } };
    await replaceSessionEntry(scope(), { sessionId, updatedAt: 1, chatType: "direct" });
    const saved = await saveMediaBuffer(PNG, "image/png", "outbound-fixture", 1024, "photo.png");
    imagePath = saved.path;
    receiptConversation = sessionKey;
    receiptMedia = [{ path: imagePath, contentType: "image/png", kind: "image" }];
    mediaWithoutImageFacts = undefined;
    rejectBeforeDispatchForMedia = undefined;
    mediaAttempts = [];
    failMedia = false;
    transportSawMessageCount = -1;
    const sendText = async (ctx: ChannelOutboundContext) => ({
      channel: "matrix" as const,
      messageId: ctx.deliveryOperationId ?? "text-unkeyed",
      conversationId: ctx.to,
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              sendText,
              sendMedia: async (ctx) => {
                mediaAttempts.push(ctx);
                if (rejectBeforeDispatchForMedia && ctx.mediaUrl === rejectBeforeDispatchForMedia) {
                  rejectBeforeDispatchForMedia = undefined;
                  throw new PlatformMessageNotDispatchedError("fixture stopped before dispatch", {
                    cause: undefined,
                  });
                }
                transportSawMessageCount = (await messages()).length;
                await ctx.onPlatformSendDispatch?.();
                if (failMedia) {
                  throw new Error("fixture transport rejected image");
                }
                return {
                  ...(await sendText(ctx)),
                  conversationId: receiptConversation,
                  ...(ctx.mediaUrl === mediaWithoutImageFacts
                    ? {}
                    : {
                        // This fixture deliberately crosses the untyped plugin runtime boundary.
                        meta: { transcriptMedia: receiptMedia } as Record<string, unknown>,
                      }),
                };
              },
            },
          }),
        },
      ]),
    );
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.unstubAllEnvs();
  });

  const sendImage = async (idempotencyKey = "producer-image") =>
    deliverOutboundPayloads({
      cfg,
      channel: "matrix",
      to: sessionKey,
      payloads: [{ text: "Here is the image", mediaUrl: "https://example.test/photo.png" }],
      mirror: { agentId: "main", sessionKey, expectedSessionId: sessionId, idempotencyKey },
      queuePolicy: "required",
    });

  it("persists one image-and-caption row after transport, reuses its producer key, and keeps independent sends distinct", async () => {
    await sendImage();
    expect(transportSawMessageCount).toBe(0);
    const first = await messages();
    expect(first).toHaveLength(1);
    expect(first[0]?.message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Here is the image" }],
    });
    expect(first[0]?.idempotencyKey).toBe("producer-image");
    expect(readPersistedMediaFacts(first[0]!.message)).toMatchObject([
      { path: imagePath, contentType: "image/png", kind: "image" },
    ]);

    await sendImage();
    expect((await messages()).map((entry) => entry.entryId)).toEqual([first[0]?.entryId]);
    await sendImage("independent-image");
    expect(await messages()).toHaveLength(2);
  });

  it("keeps independent unkeyed direct image sends as separate native rows", async () => {
    const params = {
      cfg,
      channel: "matrix" as const,
      to: sessionKey,
      payloads: [{ text: "Here is the image", mediaUrl: "https://example.test/photo.png" }],
      mirror: { agentId: "main", sessionKey, expectedSessionId: sessionId },
      queuePolicy: "required" as const,
    };
    await deliverOutboundPayloads(params);
    await deliverOutboundPayloads(params);

    const rows = await messages();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => readPersistedMediaFacts(row.message)?.length === 1)).toBe(true);
    expect(rows.every((row) => row.idempotencyKey?.startsWith("outbound-mirror:v1:"))).toBe(true);
    expect(new Set(rows.map((row) => row.idempotencyKey)).size).toBe(2);
  });

  it("keeps unkeyed partial prepared-batch subsets distinct and reuses the same subset key", async () => {
    rejectBeforeDispatchForMedia = "https://example.test/second.png";
    const payloads = [
      { text: "Here is the image", mediaUrl: "https://example.test/first.png" },
      { text: "Here is the image", mediaUrl: "https://example.test/second.png" },
    ];
    const preparedBatch = createUnmodifiedPreparedOutboundBatch(payloads);
    const params = {
      cfg,
      channel: "matrix" as const,
      to: sessionKey,
      payloads,
      preparedBatch,
      deliveryOperationIntentId: "fixture-partial-image-intent",
      mirror: { agentId: "main", sessionKey, expectedSessionId: sessionId },
      bestEffort: true,
    };
    await deliverOutboundPayloadsCore(params);
    const first = await messages();
    expect(first).toHaveLength(1);
    expect(mediaAttempts).toHaveLength(2);

    const remaining = {
      ...params,
      preparedBatch: { ...preparedBatch, entries: preparedBatch.entries.slice(1) },
    };
    await deliverOutboundPayloadsCore(remaining);
    const rows = await messages();
    expect(mediaAttempts).toHaveLength(3);
    expect(mediaAttempts[2]?.deliveryOperationId).toBe(mediaAttempts[1]?.deliveryOperationId);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.entryId).toBe(first[0]?.entryId);
    expect(rows.every((row) => readPersistedMediaFacts(row.message)?.length === 1)).toBe(true);
    expect(new Set(rows.map((row) => row.idempotencyKey)).size).toBe(2);

    await deliverOutboundPayloadsCore(remaining);
    expect((await messages()).map((row) => row.entryId)).toEqual(rows.map((row) => row.entryId));
  });

  it.each([
    "foreign conversation",
    "outside media store",
    "missing asset",
    "wrong kind",
    "wrong cardinality",
    "symlink",
  ])("keeps the text fallback without exposing %s metadata", async (defect) => {
    if (defect === "foreign conversation") {
      receiptConversation = "agent:main:other";
    }
    if (defect === "outside media store") {
      receiptMedia = [{ path: fixture.storePath(), contentType: "image/png", kind: "image" }];
    }
    if (defect === "missing asset") {
      receiptMedia = [
        {
          path: path.join(path.dirname(imagePath), "missing.png"),
          contentType: "image/png",
          kind: "image",
        },
      ];
    }
    if (defect === "wrong kind") {
      receiptMedia = [{ path: imagePath, contentType: "text/plain", kind: "image" }];
    }
    if (defect === "wrong cardinality") {
      receiptMedia = [
        { path: imagePath, contentType: "image/png", kind: "image" },
        { path: imagePath, contentType: "image/png", kind: "image" },
      ];
    }
    if (defect === "symlink") {
      const link = path.join(path.dirname(imagePath), "linked.png");
      await fs.symlink(imagePath, link);
      receiptMedia = [{ path: link, contentType: "image/png", kind: "image" }];
    }

    await sendImage();
    const rows = await messages();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Here is the image\nphoto.png" }],
    });
    expect(readPersistedMediaFacts(rows[0]!.message)).toBeUndefined();
  });

  it("preserves native image-only content through the admitted late cron mirror and reuses its producer key", async () => {
    const delivered: NormalizedOutboundPayload[] = [];
    await deliverOutboundPayloads({
      cfg,
      channel: "matrix",
      to: sessionKey,
      payloads: [{ mediaUrl: "https://example.test/photo.png" }],
      onDeliveredPayload: (payload) => {
        delivered.push(payload);
      },
      queuePolicy: "required",
    });
    expect(await messages()).toHaveLength(0);
    const projection = projectDeliveredDirectCronPayloadsForMirror(delivered, sessionKey);
    const mirror = {
      ...scope(),
      expectedSessionId: sessionId,
      text: resolveDirectCronTranscriptMirrorText(projection),
      media: projection.media,
      idempotencyKey: "cron-direct-delivery:v1:fixture",
      config: cfg,
    };
    for (let i = 0; i < 2; i++) {
      await appendAdmittedDirectCronDeliveryTranscriptMirror({
        job: { id: "fixture" } as CronJob,
        mirror,
      });
    }
    const rows = await messages();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toMatchObject({ role: "assistant", content: [] });
    expect(rows[0]?.idempotencyKey).toBe(mirror.idempotencyKey);
    expect(readPersistedMediaFacts(rows[0]!.message)).toMatchObject([
      { path: imagePath, contentType: "image/png", kind: "image" },
    ]);
  });

  it.each(["agent:main:matrix:dm:other-fixture", "!external-room:example"])(
    "keeps image names when target %s differs from the native mirror session",
    async (target) => {
      receiptConversation = target;
      await deliverOutboundPayloads({
        cfg,
        channel: "matrix",
        to: receiptConversation,
        payloads: [{ text: "Another conversation", mediaUrl: "https://example.test/photo.png" }],
        mirror: { agentId: "main", sessionKey, expectedSessionId: sessionId },
        queuePolicy: "required",
      });
      const rows = await messages();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.message).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "Another conversation\nphoto.png" }],
      });
      expect(readPersistedMediaFacts(rows[0]!.message)).toBeUndefined();
    },
  );

  it("retains both attachment names when a mixed image and PDF payload supplies only image facts", async () => {
    mediaWithoutImageFacts = "https://example.test/report.pdf";
    await deliverOutboundPayloads({
      cfg,
      channel: "matrix",
      to: sessionKey,
      payloads: [
        {
          text: "Both files",
          mediaUrls: ["https://example.test/photo.png", mediaWithoutImageFacts],
        },
      ],
      mirror: { agentId: "main", sessionKey, expectedSessionId: sessionId },
      queuePolicy: "required",
    });
    const rows = await messages();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Both files\nphoto.png, report.pdf" }],
    });
    expect(readPersistedMediaFacts(rows[0]!.message)).toBeUndefined();
  });

  it("mirrors only successful payloads when an image fails after an earlier text send", async () => {
    failMedia = true;
    await deliverOutboundPayloads({
      cfg,
      channel: "matrix",
      to: sessionKey,
      payloads: [
        { text: "Delivered text" },
        { text: "Rejected image", mediaUrl: "https://example.test/photo.png" },
      ],
      mirror: { agentId: "main", sessionKey, expectedSessionId: sessionId },
      bestEffort: true,
      queuePolicy: "required",
    });
    const rows = await messages();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Delivered text" }],
    });
    expect(readPersistedMediaFacts(rows[0]!.message)).toBeUndefined();
  });
});
