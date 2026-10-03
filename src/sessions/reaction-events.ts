import type { SessionReactionEvent } from "../../packages/gateway-protocol/src/index.js";
import { resolveGlobalSet } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";

const listeners = resolveGlobalSet<(event: SessionReactionEvent) => void>(
  Symbol.for("openclaw.sessionReactionListeners"),
  "close-and-restart",
);
export function onSessionReaction(listener: (event: SessionReactionEvent) => void): () => void {
  return registerListener(listeners, listener);
}
export function publishSessionReaction(event: SessionReactionEvent): void {
  notifyListeners(listeners, event);
}
