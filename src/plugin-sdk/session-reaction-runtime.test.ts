import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { ChatEventSchema } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { installSessionToolResultGuard } from "../agents/session-tool-result-guard.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { createMessageTool } from "../agents/tools/message-tool-execution.js";
import { dispatchChannelMessageAction } from "../channels/plugins/message-action-dispatch.js";
import type { ChannelMessageActionContext, ChannelPlugin } from "../channels/plugins/types.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import {
  listSessionReactions,
  setSessionReactionAsync,
} from "../config/sessions/session-reaction-store.js";
import {
  mintMessageActionTurnCapability,
  resolveMessageActionTurnAuthorization,
  revokeMessageActionTurnCapability,
} from "../gateway/message-action-turn-capability.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "../gateway/server-chat.js";
import { broadcastChatFinal } from "../gateway/server-methods/chat-broadcast.js";
import { readSessionReactionCompletionsAsync } from "../gateway/session-transcript-readers.js";
import {
  getAgentRunContext,
  claimAgentRunDelegatedAuthority,
  registerAgentRunContext,
  resetAgentRunRegistryForTest,
} from "../infra/agent-run-registry.js";
import { runMessageAction } from "../infra/outbound/message-action-runner.js";
import { peekSystemEventEntries } from "../infra/system-events.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { onSessionReaction } from "../sessions/reaction-events.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reactToCurrentSessionMessage } from "./session-reaction-runtime.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
  resetAgentRunRegistryForTest();
});

async function fixture(handle: (context: ChannelMessageActionContext) => Promise<unknown>) {
  const sessionKey = "agent:main:reaction-sdk-qa";
  const sessionId = "sdk-session";
  const scope = {
    agentId: "main",
    sessionKey,
    storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
  };
  await upsertSessionEntryCore(scope, { sessionId, updatedAt: Date.now() });
  const { messageId } = await appendTranscriptMessage(
    { ...scope, sessionId },
    {
      message: {
        role: "user",
        idempotencyKey: "client-admission:user",
        content: [{ type: "text", text: "A saved prompt" }],
      },
    },
  );
  const run = { agentId: "main", runId: "sdk-run", sessionKey, sessionId };
  registerAgentRunContext(run.runId, { ...run, projectSessionLifecycle: false });
  claimAgentRunDelegatedAuthority({ runId: run.runId, instanceId: "sdk-run-instance" });
  const token = mintMessageActionTurnCapability({
    ...run,
    currentSessionMessageId: messageId,
    assertDashboardReadCurrent: () => {},
    expiresWithRun: true,
  });
  const authorization = resolveMessageActionTurnAuthorization({ ...run, token });
  const plugin: ChannelPlugin = {
    ...createChannelTestPluginBase({ id: "testchat" }),
    capabilities: { chatTypes: ["direct"], reactions: true, nativeSessionReactions: true },
    outbound: {
      deliveryMode: "direct",
      sendText: async () => {
        throw new Error("Native reactions must not send platform text");
      },
      sendMedia: async () => {
        throw new Error("Native reactions must not send platform media");
      },
    },
    actions: {
      describeMessageTool: () => ({ actions: ["react"] }),
      handleAction: async (context) => ({ content: [], details: await handle(context) }),
    },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "testchat", source: "test", plugin }]));
  const context: Parameters<typeof dispatchChannelMessageAction>[0] = {
    cfg: { agents: { list: [{ id: "main", identity: { name: "Jay" } }] } },
    channel: "testchat",
    action: "react",
    params: { messageId, emoji: "❤️" },
    agentId: "main",
    sessionKey,
    sessionId,
    messageActionAuthorization: authorization,
  };
  return { scope, sessionId, sessionKey, messageId, context, token, run };
}

describe("native current-turn agent reaction", () => {
  it("commits an independent agent actor, publishes committed state, and closes retained writes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      let retained: ChannelMessageActionContext | undefined;
      const observed: unknown[] = [];
      let performWrite = true;
      const stop = onSessionReaction((event) => observed.push(event));
      const f = await fixture(async (context) => {
        retained = context;
        expect(context.sessionReactions?.currentMessageId).toBeTypeOf("string");
        if (!performWrite) {
          return {
            ok: true,
            nativeSessionReaction: {
              ...context,
              messageId: context.params.messageId,
              changed: true,
              remove: false,
            },
          };
        }
        const messageId = context.params.messageId ?? context.sessionReactions?.currentMessageId;
        if (typeof messageId !== "string") {
          throw new Error("Native fixture requires a canonical message ID");
        }
        const write = await reactToCurrentSessionMessage(context, {
          messageId,
          emoji: "❤️",
          remove: Boolean(context.params.remove),
        });
        return { ok: true, applied: write.changed, ...write };
      });
      try {
        await setSessionReactionAsync(f.scope, {
          messageId: f.messageId,
          expectedSessionId: f.sessionId,
          emoji: "❤️",
          identityId: "human-profile",
          identityLabel: "Person",
        });
        const tool = createMessageTool({
          config: { ...f.context.cfg, channels: { testchat: { enabled: true } } },
          agentId: f.run.agentId,
          agentSessionKey: f.sessionKey,
          sessionId: f.sessionId,
          runId: f.run.runId,
          messageActionTurnCapability: f.token,
          currentChannelProvider: "webchat",
          runMessageAction,
          getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
          resolveCommandSecretRefsViaGateway: async ({ config }) => ({
            resolvedConfig: config,
            diagnostics: [],
            targetStatesByPath: {},
            hadUnresolvedTargets: false,
          }),
        });
        const added = await tool.execute("native-terminal-add", {
          action: "react",
          channel: "testchat",
          emoji: "❤️",
          final: true,
        });
        expect(added.details).toHaveProperty("messageDelivery.sourceReplyDelivered", true);
        const expectedCompletion = {
          runId: "client-admission",
          executionRunId: f.run.runId,
          sourceIdempotencyKey: "client-admission:user",
          sessionKey: f.sessionKey,
          agentId: "main",
          sessionId: f.sessionId,
          messageId: f.messageId,
          emoji: "❤️",
          actor: { type: "agent", id: "agent:main", label: "Jay" },
        };
        expect(added.details).toHaveProperty(
          "messageDelivery.nativeSessionReactionCompletion",
          expectedCompletion,
        );
        const manager = await SessionManager.openAsync({ ...f.scope, sessionId: f.sessionId });
        installSessionToolResultGuard(manager, { runId: f.run.runId });
        await manager.appendMessageAsync(
          makeAgentAssistantMessage({
            role: "assistant",
            content: [
              { type: "toolCall", id: "native-terminal-add", name: "message", arguments: {} },
            ],
          }),
        );
        const completedTool = await manager.appendMessageAsync({
          role: "toolResult",
          toolName: "message",
          toolCallId: "native-terminal-add",
          content: added.content,
          details: { ...asOptionalRecord(added.details), oversizedDiagnostics: "z".repeat(20000) },
          timestamp: Date.now(),
          isError: false,
        });
        // Read the actual native persisted fact after dropping in-memory presentation evidence.
        const run = getAgentRunContext(f.run.runId)!;
        const nativeCompletion = run.nativeSessionReactionCompletion;
        delete run.nativeSessionReactionCompletion;
        expect(
          await readSessionReactionCompletionsAsync({ ...f.scope, sessionId: f.sessionId }, [
            f.messageId,
          ]),
        ).toEqual([expectedCompletion]);
        expect(
          await readSessionReactionCompletionsAsync({ ...f.scope, sessionId: f.sessionId }, [
            "outside-session",
          ]),
        ).toEqual([]);
        run.nativeSessionReactionCompletion = nativeCompletion;
        const chatRunState = createChatRunState();
        chatRunState.registry.add(f.run.runId, {
          sessionKey: f.sessionKey,
          clientRunId: "client-admission",
          agentId: "main",
        });
        const finals: unknown[] = [];
        const handler = createAgentEventHandler({
          broadcast: (event, payload) => {
            if (event === "chat") {
              finals.push(payload);
            }
          },
          broadcastToConnIds: () => {},
          nodeSendToSession: () => {},
          nodeHasSessionSubscribers: () => false,
          agentRunSeq: new Map(),
          chatRunState,
          resolveSessionKeyForRun: () => f.sessionKey,
          clearAgentRunContext: () => {},
          toolEventRecipients: chatRunState.toolEventRecipients,
          sessionEventSubscribers: createSessionEventSubscriberRegistry(),
          sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
          loadGatewaySessionLifecycleSnapshotForEvent: () => ({ row: null }),
        });
        handler({
          runId: f.run.runId,
          agentId: "main",
          sessionKey: f.sessionKey,
          sessionId: f.sessionId,
          lifecycleGeneration: run.lifecycleGeneration,
          seq: 1,
          ts: Date.now(),
          stream: "lifecycle",
          data: { phase: "end" },
        });
        expect(finals).toMatchObject([
          {
            state: "final",
            runId: "client-admission",
            sessionKey: f.sessionKey,
            nativeSessionReactionCompletion: expectedCompletion,
          },
        ]);
        expect(Value.Check(ChatEventSchema, finals[0])).toBe(true);
        const dispatchedFinals: unknown[] = [];
        broadcastChatFinal({
          runId: f.run.runId,
          sessionKey: f.sessionKey,
          agentId: "main",
          context: {
            broadcast: (event, payload) => {
              if (event === "chat") {
                dispatchedFinals.push(payload);
              }
            },
            nodeSendToSession: () => {},
            agentRunSeq: new Map(),
          },
        });
        expect(dispatchedFinals).toMatchObject([
          {
            state: "final",
            runId: f.run.runId,
            nativeSessionReactionCompletion: {
              runId: f.run.runId,
              sessionId: f.sessionId,
              messageId: f.messageId,
              actor: { type: "agent", id: "agent:main", label: "Jay" },
            },
          },
        ]);
        expect(dispatchedFinals[0]).not.toHaveProperty(
          "nativeSessionReactionCompletion.executionRunId",
        );
        expect(Value.Check(ChatEventSchema, dispatchedFinals[0])).toBe(true);

        expect(listSessionReactions(f.scope, { sessionId: f.sessionId })[f.messageId]).toEqual([
          {
            emoji: "❤️",
            count: 2,
            identities: [
              { id: "human-profile", label: "Person" },
              { id: "agent:main", label: "Jay" },
            ],
          },
        ]);
        expect(observed).toMatchObject([
          {
            actor: { type: "agent", id: "agent:main", label: "Jay" },
            action: "added",
            messageId: f.messageId,
            reactions: [{ count: 2 }],
          },
        ]);
        expect(peekSystemEventEntries(f.sessionKey)).toEqual([]);
        await expect(
          reactToCurrentSessionMessage(retained!, {
            messageId: f.messageId,
            emoji: "❤️",
            remove: true,
          }),
        ).rejects.toThrow("invocation is closed");
        const noOp = await tool.execute("native-terminal-noop", {
          action: "react",
          channel: "testchat",
          emoji: "❤️",
          final: true,
        });
        expect(noOp.details).not.toHaveProperty("messageDelivery.sourceReplyDelivered");
        const removed = await tool.execute("native-terminal-remove", {
          action: "react",
          channel: "testchat",
          emoji: "❤️",
          remove: true,
          final: true,
        });
        expect(removed.details).not.toHaveProperty("messageDelivery.sourceReplyDelivered");
        expect(listSessionReactions(f.scope, { sessionId: f.sessionId })[f.messageId]).toEqual([
          { emoji: "❤️", count: 1, identities: [{ id: "human-profile", label: "Person" }] },
        ]);
        const { messageId: otherMessageId } = await appendTranscriptMessage(
          { ...f.scope, sessionId: f.sessionId },
          {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "A different saved message" }],
            },
          },
        );
        const other = await tool.execute("native-other-message", {
          action: "react",
          channel: "testchat",
          messageId: otherMessageId,
          emoji: "❤️",
          final: true,
        });
        expect(other.details).not.toHaveProperty("messageDelivery.sourceReplyDelivered");
        performWrite = false;
        const forged = await tool.execute("native-forged-receipt", {
          action: "react",
          channel: "testchat",
          emoji: "❤️",
          final: true,
        });
        expect(forged.details).not.toHaveProperty("messageDelivery.sourceReplyDelivered");
        expect(forged.details).not.toHaveProperty("nativeSessionReaction");
        const selected = await SessionManager.openAsync({ ...f.scope, sessionId: f.sessionId });
        selected.branch(f.messageId);
        await selected.appendMessageWithTranscriptAnchorAsync(
          makeAgentAssistantMessage({
            role: "assistant",
            content: [{ type: "text", text: "A new branch" }],
          }),
        );
        expect(
          await readSessionReactionCompletionsAsync({ ...f.scope, sessionId: f.sessionId }, [
            f.messageId,
          ]),
        ).toEqual([]);
        selected.branch(completedTool!);
        await selected.appendMessageWithTranscriptAnchorAsync(
          makeAgentAssistantMessage({
            role: "assistant",
            content: [{ type: "text", text: "Resume the completed branch" }],
          }),
        );
        expect(
          await readSessionReactionCompletionsAsync({ ...f.scope, sessionId: f.sessionId }, [
            f.messageId,
          ]),
        ).toEqual([expectedCompletion]);
        selected.appendResetBoundary("new", f.messageId);
        expect(
          await readSessionReactionCompletionsAsync({ ...f.scope, sessionId: f.sessionId }, [
            f.messageId,
          ]),
        ).toEqual([]);
      } finally {
        stop();
        revokeMessageActionTurnCapability(f.token);
      }
    });
  });

  it("rejects expired turn authority, stale transcript instances, and cross-session message IDs", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = await fixture((context) =>
        reactToCurrentSessionMessage(context, {
          messageId: String(context.params.messageId),
          emoji: "😂",
          remove: Boolean(context.params.remove),
        }),
      );
      try {
        await expect(
          dispatchChannelMessageAction({
            ...f.context,
            params: { ...f.context.params, messageId: "outside-session" },
          }),
        ).rejects.toThrow("Unknown saved message");
        await upsertSessionEntryCore(f.scope, {
          sessionId: "replacement-session",
          updatedAt: Date.now(),
        });
        await expect(dispatchChannelMessageAction(f.context)).rejects.toThrow();
        expect(listSessionReactions(f.scope, { sessionId: "replacement-session" })).toEqual({});
        revokeMessageActionTurnCapability(f.token);
        await expect(dispatchChannelMessageAction(f.context)).rejects.toThrow(
          "current-turn authority",
        );
      } finally {
        revokeMessageActionTurnCapability(f.token);
      }
    });
  });
});
