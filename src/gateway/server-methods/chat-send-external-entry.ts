import { GATEWAY_CLIENT_MODES } from "../../../packages/gateway-protocol/src/client-info.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import { getLoadedChannelPlugin } from "../../channels/plugins/index.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../../sessions/session-key-utils.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import type { ChatSendExternalAuthorityAdmission } from "./chat-send-external-authority-contract.js";
import { handleChatSend } from "./chat-send-handler.js";
import {
  isDirectGatewayChatUserTurn,
  resolveGatewayChatCronCreatorAuthorityAdmission,
} from "./cron-creator-authority-admission.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const externalAuthorityAdmission: ChatSendExternalAuthorityAdmission = {
  allowsDashboardReads: (params) =>
    params.client?.internal?.authenticatedControlUi === true &&
    authorizeOperatorScopesForMethod("chat.send", params.client.connect.scopes ?? []).allowed &&
    isDirectGatewayChatUserTurn({
      ...params,
      resolvedSessionKey: params.sessionKey,
      isIncognito: params.isIncognitoEntry || isIncognitoSessionKey(params.sessionKey),
      isDirectExternalUser: true,
    }),
  allowsNativeSessionReactions: (params) => {
    const client = params.client;
    const origin = params.explicitOrigin;
    // These are server-admitted facts: device proof/pairing and profile ownership
    // settle before registration. A display name or external_user label grants nothing.
    if (
      client?.internal?.authenticatedOperator !== true ||
      client.connect.role !== "operator" ||
      client.connect.client.mode !== GATEWAY_CLIENT_MODES.UI ||
      !client.connect.device?.id ||
      !client.authenticatedUserProfile?.profileId ||
      params.isIncognitoEntry ||
      params.isReconnectResume ||
      (params.inputProvenance !== undefined &&
        (params.inputProvenance.kind !== "external_user" ||
          Object.keys(params.inputProvenance).length !== 1)) ||
      !authorizeOperatorScopesForMethod("chat.send", client.connect.scopes ?? []).allowed ||
      (origin &&
        (normalizeSessionKeyPreservingOpaquePeerIds(origin.originatingTo) !== params.sessionKey ||
          origin.messageThreadId !== undefined ||
          getLoadedChannelPlugin(origin.originatingChannel ?? "")?.capabilities
            .nativeSessionReactions !== true))
    ) {
      return false;
    }
    // Explicit same-session native return routing is delivery metadata only.
    // It does not admit platform actions or any first-party dashboard read grant.
    return isDirectGatewayChatUserTurn({
      ...params,
      inputProvenance: undefined,
      hasExplicitOrigin: false,
      resolvedSessionKey: params.sessionKey,
      isIncognito: false,
      isDirectExternalUser: true,
    });
  },
  resolve: (params) => {
    const authority = resolveGatewayChatCronCreatorAuthorityAdmission({
      runId: params.runId,
      resolvedSessionKey: params.sessionKey,
      spawnedBy: params.spawnedBy,
      client: params.client,
      isCurrent: params.isCurrent,
      inputProvenance: params.inputProvenance,
      hasExplicitOrigin: params.hasExplicitOrigin,
      hasRestoredCronContinuation: params.hasRestoredCronContinuation,
      isIncognito: params.isIncognitoEntry || isIncognitoSessionKey(params.sessionKey),
      isReconnectResume: params.isReconnectResume,
      isSystemGenerated: params.isSystemGenerated,
      turnKind: params.turnKind,
      isDirectExternalUser: true,
    });
    return authority
      ? createCronCreatorAuthorityCapability(
          authority.runId,
          authority.callerOrigin,
          authority.managementEntitlement,
          authority.isCurrent,
          undefined,
          authority.requesterOwner,
          authority.callerScopedCreation,
        )
      : undefined;
  },
  run: (capability, run, signal) => runWithCronCreatorAuthorityCapability(capability, run, signal),
};

/** Authenticated external chat entry; internal re-entry must call handleChatSend directly. */
export function handleDirectExternalChatSend(
  options: GatewayRequestHandlerOptions,
  onAdmissionOwned?: () => Promise<boolean>,
): Promise<void> {
  return handleChatSend(options, onAdmissionOwned, externalAuthorityAdmission);
}
