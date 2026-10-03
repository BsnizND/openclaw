import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import * as dispatch from "../../auto-reply/dispatch.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.native.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createChatRunState } from "../server-chat-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import { resolveSessionMutationAuthorization } from "../session-sharing.js";
import * as chatDispatch from "./chat-send-agent-dispatch.js";
import { handleDirectExternalChatSend } from "./chat-send-external-entry.js";
import { handleChatSend } from "./chat-send-handler.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

type DispatchOptions = Parameters<typeof dispatch.dispatchInboundMessageWithProjectedDispatcher>[0];

const admissionScenarios = [
  "removed",
  "replaced",
  "aborted",
  "released",
  "terminal",
  "rotated",
  "queued",
  "narrow-first-send",
  "dashboard",
  "dashboard-writer",
  "dashboard-credential-revoked",
  "dashboard-member-revoked",
  "dashboard-unattested",
  "dashboard-internal",
  "paired-ui",
  "paired-ui-credential-revoked",
  "paired-ui-member-revoked",
  "paired-ui-unpaired",
  "paired-ui-backend",
  "paired-ui-system",
  "paired-ui-foreign-origin",
] as const;

it.each(admissionScenarios)(
  "keeps prepared-session binding with its exact admission: %s",
  async (scenario) => {
    const paired = scenario.startsWith("paired-ui");
    const nativeReactionAllowed =
      paired &&
      ["paired-ui", "paired-ui-credential-revoked", "paired-ui-member-revoked"].includes(scenario);
    const dashboard = scenario.startsWith("dashboard");
    const directDashboard = (dashboard && scenario !== "dashboard-internal") || paired;
    const dashboardReadAllowed =
      dashboard && directDashboard && scenario !== "dashboard-unattested";
    const membershipRequired = scenario.endsWith("member-revoked");
    const closure =
      scenario === "narrow-first-send"
        ? "rotated"
        : scenario === "dashboard-writer"
          ? "aborted"
          : dashboard || paired
            ? "released"
            : scenario;
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const registry = captureActivePluginRegistrySnapshot();
      const plugin = createChannelTestPluginBase({
        id: "nativechat",
        capabilities: { chatTypes: ["direct"], nativeSessionReactions: true },
      });
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]),
      );
      const runId = "retained-preparation";
      const sessionKey = scenario === "dashboard" ? "agent:main:main" : "agent:main:binding";
      const scope = { agentId: "main", sessionKey };
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:unrelated" },
        { sessionId: "unrelated-session", updatedAt: Date.now() },
      );
      const clone = vi.spyOn(globalThis, "structuredClone");
      const unrelatedCloneCount = () =>
        clone.mock.calls.filter(
          ([entry]) =>
            entry &&
            typeof entry === "object" &&
            "sessionId" in entry &&
            entry.sessionId === "unrelated-session",
        ).length;
      const profile = ensureProfileForEmail("authoring-binding@example.test");
      const owner = membershipRequired
        ? ensureProfileForEmail("authoring-owner@example.test")
        : profile;
      const initialSessionId = membershipRequired ? "member-session" : runId;
      const createdActor = { type: "human", source: "profile", id: owner.id } as const;
      if (membershipRequired) {
        await upsertSessionEntryCore(scope, {
          sessionId: initialSessionId,
          updatedAt: Date.now(),
          visibility: "suggest",
          createdActor,
        });
        addSessionMember(scope, { identityId: profile.id, addedBy: owner.id });
      }
      const connection = new AbortController();
      const hasCurrentClientAuthority = vi.fn(() => true);
      const client: GatewayClient = {
        connId: "authoring-binding",
        ...(paired ? { internal: { authenticatedOperator: true as const } } : {}),
        connectionSignal: connection.signal,
        ...(dashboard && scenario !== "dashboard-unattested"
          ? {
              internal: {
                authenticatedControlUi: true as const,
                ...(scenario !== "dashboard-writer" && !membershipRequired
                  ? { controlUiAdmin: true as const }
                  : {}),
              },
            }
          : {}),
        authenticatedUserProfile: {
          profileId: profile.id,
          displayName: null,
          hasAvatar: false,
          updatedAt: 1,
        },
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          role: "operator",
          scopes:
            scenario === "narrow-first-send"
              ? ["operator.sessions.write"]
              : scenario === "dashboard-writer" || membershipRequired
                ? ["operator.write"]
                : dashboard
                  ? ["operator.admin"]
                  : ["operator.read", "operator.write", "operator.admin"],
          ...(paired && scenario !== "paired-ui-unpaired"
            ? {
                device: {
                  id: "paired-app-device",
                  publicKey: "test-key",
                  signature: "test-signature",
                  signedAt: 1,
                  nonce: "test-nonce",
                },
              }
            : {}),
          client: paired
            ? {
                id: "gateway-client",
                version: "test",
                platform: "web",
                mode: scenario === "paired-ui-backend" ? "backend" : "ui",
              }
            : dashboard
              ? { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" }
              : { id: "cli", version: "test", platform: "test", mode: "cli" },
        },
      };
      const namespaceRun = prepareSystemAgentRunAdmission({}, runId, "main", "test");
      const entered = createDeferred<DispatchOptions>();
      const release = createDeferred();
      const observeDispatch = vi.spyOn(chatDispatch, "startChatDispatch");
      const holdDispatch = vi
        .spyOn(dispatch, "dispatchInboundMessageWithProjectedDispatcher")
        .mockImplementation(async (options) => {
          entered.resolve(options);
          await release.promise;
          return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
        });
      const context = {
        chatAbortControllers: new Map(),
        chatQueuedTurns: new Map(),
        chatRunState: createChatRunState(),
        dedupe: new Map(),
        agentRunSeq: new Map(),
        getRuntimeConfig,
        addChatRun: vi.fn(),
        removeChatRun: vi.fn(),
        broadcast: vi.fn(),
        broadcastToConnIds: vi.fn(),
        nodeSendToSession: vi.fn(),
        getSessionEventSubscriberConnIds: () => new Set<string>(),
        logGateway: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      } as unknown as GatewayRequestContext;
      let owned: Parameters<typeof chatDispatch.startChatDispatch>[0] | undefined;
      let reply: ReturnType<typeof createReplyOperation> | undefined;
      let successor: ReturnType<typeof registerChatAbortController> | undefined;
      let options: DispatchOptions | undefined;
      try {
        const respond = vi.fn();
        const params = {
          // Exercise the ordinary dashboard alias without an explicit agentId.
          sessionKey: scenario === "dashboard" ? "main" : sessionKey,
          message: "Keep this user turn in its session",
          ...(paired
            ? {
                ...(membershipRequired
                  ? {}
                  : {
                      originatingChannel: "nativechat",
                      originatingTo:
                        scenario === "paired-ui-foreign-origin"
                          ? "agent:main:unrelated"
                          : sessionKey,
                    }),
                ...(membershipRequired
                  ? {}
                  : {
                      systemInputProvenance: {
                        kind: scenario === "paired-ui-system" ? "internal_system" : "external_user",
                      },
                    }),
              }
            : {}),
          idempotencyKey: runId,
        };
        const authorization = resolveSessionMutationAuthorization({
          client,
          context,
          method: "chat.send",
          requestParams: params,
        });
        expect(authorization.error).toBeNull();
        const sendChat = directDashboard ? handleDirectExternalChatSend : handleChatSend;
        const request = {
          params,
          req: { type: "req" as const, id: runId, method: "chat.send", params },
          respond,
          context,
          client,
          hasCurrentClientAuthority,
          sessionMutationAuthorization: authorization.authorization,
          isWebchatConnect: () => false,
        };
        if (scenario === "narrow-first-send") {
          await handleGatewayRequest({
            ...request,
            extraHandlers: { "chat.send": handleChatSend },
          });
        } else {
          await sendChat(request);
        }
        expect(respond).toHaveBeenCalledWith(
          true,
          dashboard
            ? expect.objectContaining({ runId, status: "started" })
            : { runId, status: "started" },
          undefined,
          expect.anything(),
        );
        options = await entered.promise;
        const dashboardRead = options.replyOptions?.dashboardReadAdmission;
        expect(Boolean(dashboardRead)).toBe(dashboardReadAllowed);
        const nativeReaction = options.replyOptions?.nativeSessionReactionAdmission;
        expect(Boolean(nativeReaction)).toBe(nativeReactionAllowed);
        const sourceAuthority = dashboardRead ?? nativeReaction;
        owned = observeDispatch.mock.calls.at(-1)?.[0];
        const prepared = options.replyOptions?.onSessionPrepared;
        const runStarted = options.replyOptions?.onAgentRunStart;
        if (!owned || !prepared || !runStarted || (!paired && !owned.skillLibraryAuthoring)) {
          throw new Error("chat.send did not hand off its prepared-session callback");
        }
        // Initial resolution needs detached entries; later admission must not clone unrelated rows.
        expect.soft(unrelatedCloneCount()).toBeLessThanOrEqual(1);
        const capability = owned.skillLibraryAuthoring;
        if (paired && !membershipRequired) {
          expect(capability).toBeUndefined();
        }
        const admittedContext = await namespaceRun.admit("embedded");
        capability?.bind(admittedContext);
        const caller = createAdmittedGatewayToolCallerIdentity({
          admittedRunContext: admittedContext,
          agentId: "main",
          sessionKey,
        });
        const readLibrary = () => {
          if (!capability) {
            throw new Error("This fixture has no skill-library authority");
          }
          return withGatewayToolCallerIdentity(caller, () => capability.invoke({ action: "list" }));
        };
        const { admission, userTurn } = owned;
        const original = admission.activeRunAbort.entry;
        expect(original?.sessionId).toBe(initialSessionId);
        // This focused test controls preparation; the native WS test proves its real producer.
        await upsertSessionEntryCore(scope, {
          sessionId: membershipRequired ? initialSessionId : "committed-session",
          updatedAt: Date.now(),
          createdActor,
          ...(membershipRequired ? { visibility: "suggest" as const } : {}),
        });
        const committed = loadExactSessionEntryReadOnly(scope);
        if (!committed) {
          throw new Error("session writer did not commit");
        }
        const binding = {
          sessionKey,
          sessionId: committed.entry.sessionId,
          storePath: owned.session.storePath,
        };
        prepared(binding);
        prepared(binding);
        prepared({ ...binding, sessionKey: "agent:main:unrelated", sessionId: "foreign" });
        if (sourceAuthority) {
          expect(admission.admittedSessionId).toBe(initialSessionId);
          expect(sourceAuthority.sessionId).toBe(binding.sessionId);
          sourceAuthority.assertCurrent();
        }
        clone.mockClear();
        runStarted(runId);
        expect.soft(unrelatedCloneCount()).toBe(0);
        if (capability) {
          await expect(readLibrary()).resolves.toMatchObject({ profileId: profile.id });
        }
        if (sourceAuthority) {
          connection.abort();
          expect(admission.activeRunAbort.controller.signal.aborted).toBe(false);
          expect(sourceAuthority.assertCurrent).not.toThrow();
          if (scenario.endsWith("credential-revoked")) {
            hasCurrentClientAuthority.mockReturnValue(false);
            expect(sourceAuthority.assertCurrent).toThrow(/admission is no longer active/);
          } else if (membershipRequired) {
            removeSessionMember(scope, profile.id, undefined, binding.sessionId);
            expect(admission.activeRunAbort.controller.signal.aborted).toBe(false);
            expect(hasCurrentClientAuthority()).toBe(true);
            expect(sourceAuthority.assertCurrent).toThrow("session is suggest for this connection");
          }
        }

        if (closure === "queued") {
          expect(original?.sessionId).toBe(binding.sessionId);
          expect(admission.admittedSessionId).toBe(runId);
          expect(options.replyOptions?.turnAdoptionLifecycle?.onDeferred?.()).toBe(true);
          expect(context.chatQueuedTurns.get(runId)?.sessionId).toBe(binding.sessionId);
          await userTurn.persist();
          expect(await loadTranscriptEvents({ ...scope, ...binding })).toContainEqual(
            expect.objectContaining({ message: expect.objectContaining({ role: "user" }) }),
          );
          admission.cleanupAdmittedRun();
          expect(context.chatQueuedTurns.has(runId)).toBe(true);
        } else if (closure === "removed" || closure === "replaced") {
          admission.activeRunAbort.cleanup();
          if (closure === "replaced") {
            successor = registerChatAbortController({
              chatAbortControllers: context.chatAbortControllers,
              runId,
              sessionKey,
              sessionId: "successor-session",
              timeoutMs: 60_000,
            });
          }
        } else if (closure === "aborted") {
          admission.activeRunAbort.controller.abort();
        } else if (closure === "released") {
          admission.gatewayWorkAdmission.release();
        } else if (closure === "terminal") {
          reply = createReplyOperation({
            sessionKey,
            sessionId: binding.sessionId,
            resetTriggered: false,
            upstreamAbortSignal: admission.activeRunAbort.controller.signal,
          });
          reply.complete();
          expect(admission.activeRunAbort.controller.signal.aborted).toBe(false);
        } else {
          rotateAgentEventLifecycleGeneration();
        }
        // No await after closure: release must fence even before its promise settles.
        expect(() => prepared({ ...binding, sessionId: "late-session" })).toThrow();
        if (sourceAuthority) {
          expect(sourceAuthority.assertCurrent).toThrow();
        }
        expect(original?.sessionId).toBe(binding.sessionId);
        expect(successor?.entry?.sessionId).toBe(
          closure === "replaced" ? "successor-session" : undefined,
        );
        if (capability) {
          if (closure === "queued") {
            await expect(readLibrary()).resolves.toMatchObject({ profileId: profile.id });
          } else if (closure === "released" || closure === "aborted" || closure === "rotated") {
            await expect(readLibrary()).rejects.toThrow();
          }
        }
        if (closure !== "queued") {
          await upsertSessionEntryCore(scope, { sessionId: "late-session", updatedAt: Date.now() });
          await userTurn.persist();
          expect(
            await loadTranscriptEvents({
              ...scope,
              sessionId: "late-session",
              storePath: binding.storePath,
            }),
          ).toEqual([]);
        }
      } finally {
        restoreActivePluginRegistrySnapshot(registry);
        namespaceRun.close();
        options?.replyOptions?.turnAdoptionLifecycle?.onSettled?.();
        reply?.complete();
        successor?.cleanup();
        release.resolve();
        if (owned) {
          await vi.waitFor(() => expect(context.chatAbortControllers.has(runId)).toBe(false));
          owned.admission.cleanupAdmittedRun();
          clearAgentRunContext(runId, owned.admission.lifecycleGeneration);
        }
        holdDispatch.mockRestore();
        observeDispatch.mockRestore();
        clone.mockRestore();
      }
    });
  },
);
