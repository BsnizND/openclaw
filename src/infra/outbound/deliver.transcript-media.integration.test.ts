import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundContext } from "../../channels/plugins/outbound.types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import {
  appendAdmittedDirectCronDeliveryTranscriptMirror,
  projectDeliveredDirectCronPayloadsForMirror,
  resolveDirectCronTranscriptMirrorText,
} from "../../cron/isolated-agent/delivery-dispatch-awareness.js";
import type { CronJob } from "../../cron/types.js";
import {
  projectChatDisplayMessages,
  sanitizeChatHistoryMessages,
} from "../../gateway/chat-display-projection.js";
import * as managedMedia from "../../gateway/managed-image-attachments.js";
import { listManagedImageRecordEntries } from "../../gateway/managed-image-record-store.js";
import { readPersistedMediaFacts } from "../../media/media-facts.js";
import type { MediaFact } from "../../media/media-facts.js";
import { saveMediaBuffer } from "../../media/store.js";
import { readVisibleSessionTranscriptMessageEntries } from "../../plugin-sdk/session-transcript-runtime.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { readSessionTranscriptRunId } from "../../sessions/transcript-events.js";
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
  const managedRecords = () =>
    listManagedImageRecordEntries({ stateDir: path.resolve(fixture.sessionsDir(), "../../..") });
  const projectedMessages = async () =>
    sanitizeChatHistoryMessages(
      projectChatDisplayMessages((await messages()).map((row) => row.message)),
    );
  const appendNativeImage = () => ({
    ...scope(),
    expectedSessionId: sessionId,
    text: "Native image",
    media: [{ path: imagePath, contentType: "image/png", kind: "image" as const }],
    idempotencyKey: "native-fixture-image",
    config: cfg,
  });

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
    vi.restoreAllMocks();
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
    const originalAssetIds = managedRecords().map(({ record }) => record.attachmentId);
    expect(originalAssetIds).toHaveLength(1);
    expect((await messages()).map((entry) => entry.entryId)).toEqual([first[0]?.entryId]);
    expect(managedRecords().map(({ record }) => record.attachmentId)).toEqual(originalAssetIds);
    await sendImage("independent-image");
    expect(await messages()).toHaveLength(2);
    expect(managedRecords()).toHaveLength(2);
  });

  it("projects managed media for an expected-session append carrying a run ID", async () => {
    await appendAssistantMessageToSessionTranscript({ ...appendNativeImage(), runId: "image-run" });
    const rows = await messages();
    expect(readSessionTranscriptRunId(rows[0]?.message)).toBe("image-run");
    expect((await projectedMessages())[0]).toMatchObject({
      content: expect.arrayContaining([
        expect.objectContaining({ type: "image", url: expect.any(String) }),
      ]),
    });
    expect(managedRecords()).toMatchObject([
      { record: { messageId: rows[0]?.entryId, retentionClass: "history" } },
    ]);
  });

  it.each(["caption", "image"])(
    "rejects changed %s under the same native key while retaining the original asset",
    async (change) => {
      const params = appendNativeImage();
      await appendAssistantMessageToSessionTranscript(params);
      const first = await messages();
      const originalAssetIds = managedRecords().map(({ record }) => record.attachmentId);
      const secondImage = await saveMediaBuffer(
        PNG,
        "image/png",
        "outbound-fixture",
        1024,
        "second.png",
      );
      await expect(
        appendAssistantMessageToSessionTranscript({
          ...params,
          ...(change === "caption"
            ? { text: "Changed caption" }
            : {
                media: [{ path: secondImage.path, contentType: "image/png", kind: "image" }],
              }),
        }),
      ).rejects.toThrow(/idempotency|conflict/i);
      expect((await messages()).map((row) => row.entryId)).toEqual(first.map((row) => row.entryId));
      expect(managedRecords().map(({ record }) => record.attachmentId)).toEqual(originalAssetIds);
    },
  );

  it("cleans newly prepared media when session ownership changes before commit", async () => {
    const createBlocks = managedMedia.createManagedOutgoingMediaBlocks;
    let prepared = false;
    vi.spyOn(managedMedia, "createManagedOutgoingMediaBlocks").mockImplementationOnce(
      async (params) => {
        const blocks = await createBlocks(params);
        prepared = blocks.length === 1;
        replaceSessionEntrySync(scope(), {
          sessionId,
          updatedAt: 2,
          chatType: "direct",
          lifecycleRevision: "replacement-revision",
        });
        return blocks;
      },
    );
    await expect(
      appendAssistantMessageToSessionTranscript({
        ...appendNativeImage(),
        expectedLifecycleRevision: null,
      }),
    ).resolves.toMatchObject({ ok: false, code: "session-rebound" });
    expect(prepared).toBe(true);
    expect(await messages()).toHaveLength(0);
    expect(managedRecords()).toEqual([]);
    expect(
      await fs.readdir(path.resolve(path.dirname(imagePath), "../outgoing/originals")),
    ).toEqual([]);
  });

  it("retains committed media after a publication callback fails and reuses it on retry", async () => {
    const params = appendNativeImage();
    await expect(
      appendAssistantMessageToSessionTranscript({
        ...params,
        onMessageCommitted: () => {
          throw new Error("fixture publication failed");
        },
      }),
    ).rejects.toThrow("fixture publication failed");
    const first = await messages();
    expect(first).toHaveLength(1);
    const originalAssetIds = managedRecords().map(({ record }) => record.attachmentId);
    expect(originalAssetIds).toHaveLength(1);
    await expect(appendAssistantMessageToSessionTranscript(params)).resolves.toMatchObject({
      ok: true,
    });
    expect((await messages()).map((row) => row.entryId)).toEqual(first.map((row) => row.entryId));
    expect(managedRecords().map(({ record }) => record.attachmentId)).toEqual(originalAssetIds);
    expect(managedRecords()[0]?.record.retentionClass).toBe("history");
  });

  it("projects native mirror images as authenticated outgoing media bound to the committed row", async () => {
    await sendImage();
    const rows = await messages();
    const projected = sanitizeChatHistoryMessages(
      projectChatDisplayMessages(rows.map((row) => row.message)),
    );
    expect(projected[0]).toMatchObject({
      content: expect.arrayContaining([
        expect.objectContaining({
          type: "image",
          url: expect.stringMatching(/^\/api\/chat\/media\/outgoing\/.+\/full$/),
        }),
      ]),
    });
    expect(JSON.stringify(projected)).not.toContain(imagePath);
    expect(
      listManagedImageRecordEntries({
        stateDir: path.resolve(fixture.sessionsDir(), "../../.."),
      }),
    ).toMatchObject([
      { record: { messageId: rows[0]?.entryId, sessionKey, retentionClass: "history" } },
    ]);
  });

  it.each(["document", "mixed", "remote", "incomplete"])(
    "preserves %s transcript media through the existing native projection",
    async (kind) => {
      const savedDocument = await saveMediaBuffer(
        Buffer.from("%PDF-1.4\nfixture\n%%EOF"),
        "application/pdf",
        "outbound-fixture",
        1024,
        "report.pdf",
      );
      const document: MediaFact = {
        path: savedDocument.path,
        kind: "document",
        contentType: "application/pdf",
      };
      const cases: Record<string, MediaFact[]> = {
        document: [document],
        mixed: [...appendNativeImage().media, document],
        remote: [
          { url: "https://example.test/remote.png", kind: "image", contentType: "image/png" },
        ],
        incomplete: [{ kind: "image", contentType: "image/png" }],
      };
      const media = cases[kind]!;
      const text = `Existing ${kind} attachment`;
      await expect(
        appendAssistantMessageToSessionTranscript({
          ...appendNativeImage(),
          text,
          media,
          mediaUrls: ["https://example.test/attachment"],
        }),
      ).resolves.toMatchObject({ ok: true });
      const rows = await messages();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.message).toMatchObject({
        content: [{ type: "text", text: `${text}\nattachment` }],
      });
      expect(readPersistedMediaFacts(rows[0]!.message)).toMatchObject(media);
      expect(managedRecords()).toEqual([]);
    },
  );

  it.each(["SVG", "PNG then SVG"])(
    "preserves the native transcript when managed preparation rejects %s and cleans partial assets",
    async (sequence) => {
      const svg = await saveMediaBuffer(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" /></svg>',
        ),
        "image/svg+xml",
        "outbound-fixture",
        1024,
        "drawing.svg",
      );
      const params = appendNativeImage();
      const media: MediaFact[] = [
        ...(sequence === "PNG then SVG" ? params.media : []),
        { path: svg.path, kind: "image", contentType: "image/svg+xml" },
      ];
      await expect(
        appendAssistantMessageToSessionTranscript({ ...params, media }),
      ).resolves.toMatchObject({ ok: true });
      const rows = await messages();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.message).toMatchObject({ content: [{ type: "text", text: params.text }] });
      expect(readPersistedMediaFacts(rows[0]!.message)).toMatchObject(media);
      expect(managedRecords()).toEqual([]);
      expect(
        await fs.readdir(path.resolve(path.dirname(imagePath), "../outgoing/originals")),
      ).toEqual([]);
    },
  );

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
    expect((await projectedMessages())[0]).toMatchObject({
      content: [
        expect.objectContaining({
          type: "image",
          url: expect.stringMatching(/^\/api\/chat\/media\/outgoing\//),
        }),
      ],
    });
    expect(managedRecords()).toMatchObject([
      { record: { messageId: rows[0]?.entryId, retentionClass: "history" } },
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
