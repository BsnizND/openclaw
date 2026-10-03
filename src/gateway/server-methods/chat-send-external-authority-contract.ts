import type { CronCreatorAuthorityCapability } from "../../agents/cron-creator-authority-context.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { ChatSendExplicitOrigin } from "./chat-origin-routing.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type ChatSendExternalAdmissionParams = {
  runId: string;
  sessionKey: string;
  spawnedBy?: string;
  client: GatewayRequestHandlerOptions["client"];
  isCurrent?: () => boolean;
  inputProvenance?: InputProvenance;
  hasExplicitOrigin: boolean;
  explicitOrigin?: ChatSendExplicitOrigin;
  hasRestoredCronContinuation: boolean;
  isIncognitoEntry: boolean;
  isReconnectResume: boolean;
  isSystemGenerated: boolean;
  turnKind: "btw" | "main";
};

export type ChatSendExternalAuthorityAdmission = {
  resolve(params: ChatSendExternalAdmissionParams): CronCreatorAuthorityCapability | undefined;
  allowsDashboardReads(params: ChatSendExternalAdmissionParams): boolean;
  allowsNativeSessionReactions?(params: ChatSendExternalAdmissionParams): boolean;
  run<T>(capability: CronCreatorAuthorityCapability, run: () => T, signal?: AbortSignal): T;
};
