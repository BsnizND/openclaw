import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexDynamicToolBridge } from "../extensions/codex/src/app-server/dynamic-tools.js";
import { CodexToolProgressProjection } from "../extensions/codex/src/app-server/event-projector-tool-progress.js";
import { CodexToolTranscriptProjection } from "../extensions/codex/src/app-server/event-projector-tool-transcript.js";
import { ChatEventSchema } from "../packages/gateway-protocol/src/schema/logs-chat.js";
import { installSessionToolResultGuard } from "../src/agents/session-tool-result-guard.js";
import { SessionManager } from "../src/agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../src/agents/test-helpers/agent-message-fixtures.js";
import { createMessageTool } from "../src/agents/tools/message-tool-execution.js";
import { dispatchChannelMessageAction } from "../src/channels/plugins/message-action-dispatch.js";
import type { ChannelMessageActionContext, ChannelPlugin } from "../src/channels/plugins/types.js";
import { upsertSessionEntryCore } from "../src/config/sessions/session-accessor.sqlite-entry.js";
import { appendTranscriptMessage } from "../src/config/sessions/session-accessor.sqlite-transcript-write.js";
import {
  listSessionReactions,
  setSessionReactionAsync,
} from "../src/config/sessions/session-reaction-store.js";
import {
  mintMessageActionTurnCapability,
  resolveMessageActionTurnAuthorization,
  revokeMessageActionTurnCapability,
} from "../src/gateway/message-action-turn-capability.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "../src/gateway/server-chat.js";
import { broadcastChatFinal } from "../src/gateway/server-methods/chat-broadcast.js";
import { readSessionReactionCompletionsAsync } from "../src/gateway/session-transcript-readers.js";
import {
  getAgentRunContext,
  claimAgentRunDelegatedAuthority,
  registerAgentRunContext,
  resetAgentRunRegistryForTest,
} from "../src/infra/agent-run-registry.js";
import { runMessageAction } from "../src/infra/outbound/message-action-runner.js";
import { peekSystemEventEntries } from "../src/infra/system-events.js";
import { reactToCurrentSessionMessage } from "../src/plugin-sdk/session-reaction-runtime.js";
import { revokePluginRecord } from "../src/plugins/registry-lifecycle.js";
import { createPluginRegistry } from "../src/plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";
import type { PluginRuntime } from "../src/plugins/runtime/types.js";
import { createPluginRecord } from "../src/plugins/status.test-fixtures.js";
import { onSessionReaction } from "../src/sessions/reaction-events.js";
import { resolveOpenClawAgentSqlitePath } from "../src/state/openclaw-agent-db.paths.js";
import { createChannelTestPluginBase } from "../src/test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
  resetAgentRunRegistryForTest();
});

async function fixture(
  handle: (context: ChannelMessageActionContext) => Promise<unknown>,
  nativeReactionOnly = false,
) {
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
    ...(nativeReactionOnly
      ? { assertNativeSessionReactionCurrent: () => {} }
      : { assertDashboardReadCurrent: () => {} }),
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
  const owner = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "lifeos-app-channel",
    origin: "config",
    trustedOfficialInstall: false,
  });
  owner.registry.plugins.push(record);
  const register = () =>
    owner.createApi(record, { config: {}, registrationMode: "full" }).registerChannel({ plugin });
  register();
  setActivePluginRegistry(owner.registry);
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
  return { scope, sessionId, sessionKey, messageId, context, token, run, owner, record, register };
}

describe("native current-turn agent reaction", () => {
  it.each(["disable", "revoke", "replace", "reregister"] as const)(
    "denies the real external registration after %s before committing a reaction",
    async (change) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        let retained: ChannelMessageActionContext | undefined;
        const f: Awaited<ReturnType<typeof fixture>> = await fixture(async (context) => {
          retained = context;
          if (change === "disable") {
            f.record.enabled = false;
          } else if (change === "revoke") {
            revokePluginRecord(f.owner.registry, f.record);
          } else if (change === "replace") {
            setActivePluginRegistry(
              createPluginRegistry({
                logger: { info() {}, warn() {}, error() {}, debug() {} },
                runtime: {} as PluginRuntime,
                activateGlobalSideEffects: false,
              }).registry,
            );
          } else {
            f.register();
          }
          return await reactToCurrentSessionMessage(context, {
            messageId: f.messageId,
            emoji: "❤️",
          });
        }, true);
        try {
          await expect(dispatchChannelMessageAction(f.context)).rejects.toThrow(
            "alias authority is no longer active",
          );
          expect(retained).toBeDefined();
          expect(listSessionReactions(f.scope, { sessionId: f.sessionId })).toEqual({});
        } finally {
          revokeMessageActionTurnCapability(f.token);
        }
      });
    },
  );
  it.each(["core", "codex"] as const)(
    "commits an independent agent actor through %s, persists completion, and closes retained writes",
    async (runtime) => {
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
        }, runtime === "codex");
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
          const args = { action: "react", channel: "testchat", emoji: "❤️", final: true };
          let projectedMessages: import("../src/agents/runtime/index.js").AgentMessage[] = [];
          let added;
          if (runtime === "codex") {
            const bridge = createCodexDynamicToolBridge({
              tools: [tool],
              signal: new AbortController().signal,
              hookContext: { ...f.run, sourceReplyDeliveryMode: "message_tool_only" },
            });
            const call = {
              threadId: "codex-native-thread",
              turnId: "codex-native-turn",
              callId: "native-terminal-add",
              namespace: null,
              tool: "message",
              arguments: args,
            };
            const response = await bridge.handleToolCall(call);
            expect(response.success).toBe(true);
            expect(bridge.telemetry.sourceReplyDelivered).toBe(true);
            const params = {
              ...f.run,
              config: f.context.cfg,
              provider: "openai",
              modelId: "gpt-6.1-sol",
              model: { provider: "openai", api: "openai-chatgpt-responses" },
            } as never;
            const projection = new CodexToolTranscriptProjection(
              params,
              call.threadId,
              call.turnId,
              new CodexToolProgressProjection(params),
              Date.now,
            );
            projection.recordDynamicToolCall(call);
            projection.recordDynamicToolResult({
              callId: call.callId,
              tool: call.tool,
              success: response.success,
              contentItems: response.contentItems,
              details: response.transcriptDetails,
            });
            projectedMessages = [...projection.transcriptMessages];
            const projected = projectedMessages.find((message) => message.role === "toolResult");
            if (!projected || projected.role !== "toolResult") {
              throw new Error("Codex did not project the native reaction tool result");
            }
            added = projected;
            await expect(
              tool.execute("paired-provider-read", { action: "read", channel: "testchat" }),
            ).rejects.toThrow("native session reactions only");
          } else {
            added = await tool.execute("native-terminal-add", args);
          }
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
          if (projectedMessages.length) {
            const projectedAssistant = projectedMessages[0];
            if (projectedAssistant?.role !== "assistant") {
              throw new Error("Codex did not project the native assistant tool call");
            }
            await manager.appendMessageAsync(projectedAssistant);
          } else {
            await manager.appendMessageAsync(
              makeAgentAssistantMessage({
                role: "assistant",
                content: [
                  { type: "toolCall", id: "native-terminal-add", name: "message", arguments: {} },
                ],
              }),
            );
          }
          const completedTool = await manager.appendMessageAsync({
            ...(projectedMessages.length ? added : {}),
            role: "toolResult",
            toolName: "message",
            toolCallId: "native-terminal-add",
            content: added.content,
            details: {
              ...asOptionalRecord(added.details),
              oversizedDiagnostics: "z".repeat(20000),
            },
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
    },
  );

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
