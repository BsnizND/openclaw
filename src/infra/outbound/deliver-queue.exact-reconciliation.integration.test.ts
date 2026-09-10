import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelMessageSendTextContext } from "../../channels/message/types.js";
import type { ChannelOutboundContext } from "../../channels/plugins/outbound.types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";
import {
  boundedCronCompletionRetention,
  drainMatrixReconnect,
  matrixOutboundForQueueTest,
} from "./deliver.queue-integration.test-support.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import type { DeliverFn } from "./delivery-queue-recovery.js";
import { installDeliveryQueueTmpDirHooks } from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

describe("exact Matrix delivery queue reconciliation", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let tmpDir: string;

  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });

  beforeEach(() => {
    tmpDir = fixtures.tmpDir();
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it.each(["required", "best_effort"] as const)(
    "settles one exact Matrix %s send without restart replay",
    async (queuePolicy) => {
      process.env.OPENCLAW_STATE_DIR = tmpDir;
      const deliveryIntentId = `cron-direct-delivery:v1:exact-${queuePolicy}-completion`;
      const messageId = `exact-${queuePolicy}-message`;
      const reconcileUnknownSend = vi.fn();
      const sendText = vi.fn(async (ctx: ChannelMessageSendTextContext) => {
        expect(ctx.deliveryQueueId).toBe(deliveryIntentId);
        await ctx.onPlatformSendDispatch?.();
        return {
          messageId,
          receipt: createMessageReceiptFromOutboundResults({
            results: [{ channel: "matrix", messageId }],
            kind: "text",
          }),
        };
      });
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "matrix",
            source: "test",
            plugin: {
              ...createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
              message: {
                id: "matrix",
                durableFinal: {
                  capabilities: { text: true, reconcileUnknownSend: true },
                  reconcileUnknownSendKinds: { text: true },
                  reconcileUnknownSend,
                },
                send: { text: sendText },
              },
            },
          },
        ]),
      );
      const params = {
        cfg: {} as OpenClawConfig,
        channel: "matrix" as const,
        to: "!room:example",
        payloads: [{ text: "send exactly once with durable platform identity" }],
        queuePolicy,
        ...(queuePolicy === "best_effort" ? { bestEffort: true } : {}),
        deliveryIntentId,
        completionRetention: boundedCronCompletionRetention,
        reusePendingDeliveryIntent: true,
        requireUnknownSendReconciliation: true,
      };

      await expect(deliverOutboundPayloads(params)).resolves.toMatchObject([{ messageId }]);
      expect(sendText).toHaveBeenCalledOnce();
      expect(reconcileUnknownSend).not.toHaveBeenCalled();
      expect(
        getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
      ).toBe("completed");

      const recoveryDeliver = vi.fn<DeliverFn>(async () => []);
      await drainMatrixReconnect({ deliver: recoveryDeliver, stateDir: tmpDir });
      expect(recoveryDeliver).not.toHaveBeenCalled();
      expect(sendText).toHaveBeenCalledOnce();
    },
  );

  it("keeps ordinary send identities through ordered recovery and separates payloads, media parts, and new intents", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const attempts: ChannelOutboundContext[] = [];
    const send = async (ctx: ChannelOutboundContext) => {
      attempts.push(ctx);
      if (attempts.length === 1) {
        throw new PlatformMessageNotDispatchedError("fixture stopped before dispatch", {
          cause: undefined,
        });
      }
      await ctx.onPlatformSendDispatch?.();
      return { channel: "matrix" as const, messageId: `sent-${attempts.length}` };
    };
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              normalizePayload: ({ payload }) => (payload.text === "omit fixture" ? null : payload),
              sendText: send,
              sendMedia: send,
            },
          }),
        },
      ]),
    );
    const params = {
      cfg: {} as OpenClawConfig,
      channel: "matrix" as const,
      to: "!room:example",
      payloads: [
        { text: "omit fixture" },
        {
          text: "caption",
          mediaUrls: ["https://example.test/a.png", "https://example.test/b.png"],
        },
        { text: "caption" },
      ],
      queuePolicy: "required" as const,
    };

    await expect(deliverOutboundPayloads(params)).rejects.toThrow(
      "fixture stopped before dispatch",
    );
    expect(attempts[0]?.deliveryOperationId).toEqual(expect.any(String));
    const recovery: DeliverFn = async (replay) => deliverOutboundPayloads(replay);
    await drainMatrixReconnect({ deliver: recovery, stateDir: tmpDir });

    expect(attempts).toHaveLength(4);
    expect(attempts[1]?.deliveryOperationId).toBe(attempts[0]?.deliveryOperationId);
    expect(new Set(attempts.slice(1).map((ctx) => ctx.deliveryOperationId)).size).toBe(3);
    expect(attempts.every((ctx) => ctx.deliveryQueueId === undefined)).toBe(true);

    await deliverOutboundPayloads(params);
    expect(attempts).toHaveLength(7);
    const previousIds = new Set(attempts.slice(1, 4).map((ctx) => ctx.deliveryOperationId));
    expect(attempts.slice(4).every((ctx) => !previousIds.has(ctx.deliveryOperationId))).toBe(true);
  });
});
