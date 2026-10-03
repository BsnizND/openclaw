import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { NativeSessionReactionCompletion } from "../../../packages/gateway-protocol/src/index.js";
import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import { readPersistedReactionCompletion } from "../../sessions/reaction-completion.js";
import {
  getActiveTranscriptKysely,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import { resolveTranscriptBoundaryWindow } from "./session-accessor.sqlite-reset-window.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";

/** Existing persisted host tool facts, read inside the admitted active branch/reset snapshot. */
export function readReactionCompletionsFromProjection(
  projection: CurrentTranscriptProjection,
  messageIds: readonly string[],
): NativeSessionReactionCompletion[] {
  if (messageIds.length === 0) {
    return [];
  }
  const db = getActiveTranscriptKysely(projection.database);
  const resetSeq = resolveTranscriptBoundaryWindow(projection)?.boundarySeq ?? -1;
  const activeEvents = () =>
    db
      .selectFrom("session_transcript_active_events as active")
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "active.session_id")
          .onRef("event.seq", "=", "active.event_seq"),
      )
      .innerJoin("transcript_event_identities as identity", (join) =>
        join
          .onRef("identity.session_id", "=", "active.session_id")
          .onRef("identity.seq", "=", "active.event_seq"),
      )
      .where("active.session_id", "=", projection.resolved.sessionId)
      .where("event.seq", ">", resetSeq);
  const payload = transcriptEventJsonSql(projection.database.db, "event");
  const users = new Map<string, { seq: number; sourceKey?: string }>();
  for (const row of iterateSqliteQuerySync(
    projection.database.db,
    activeEvents()
      .select(["identity.event_id", "event.seq", payload.as("event_json")])
      .where("identity.event_id", "in", [...messageIds]),
  )) {
    const message = asOptionalRecord(safeParseJsonRecord(row.event_json)?.message);
    if (message?.role === "user") {
      users.set(row.event_id, {
        seq: row.seq,
        sourceKey: typeof message.idempotencyKey === "string" ? message.idempotencyKey : undefined,
      });
    }
  }
  if (!users.size) {
    return [];
  }
  const query = activeEvents()
    .select(["event.seq", payload.as("event_json")])
    .where(
      (eb) => eb.fn<string>("json_extract", [payload, eb.val("$.message.role")]),
      "=",
      "toolResult",
    )
    .where(
      (eb) => eb.fn<string>("json_extract", [payload, eb.val("$.message.toolName")]),
      "=",
      "message",
    )
    .where(
      (eb) =>
        eb.fn<string>("json_extract", [
          payload,
          eb.val("$.message.details.messageDelivery.nativeSessionReactionCompletion.messageId"),
        ]),
      "in",
      [...users.keys()],
    )
    .orderBy("event.seq", "desc");
  const completions = new Map<string, NativeSessionReactionCompletion>();
  for (const row of iterateSqliteQuerySync(projection.database.db, query)) {
    const message = asOptionalRecord(safeParseJsonRecord(row.event_json)?.message);
    if (message?.isError === true) {
      continue;
    }
    const fact = readPersistedReactionCompletion(message?.details);
    const user = fact && users.get(fact.messageId);
    if (
      fact &&
      user &&
      row.seq > user.seq &&
      fact.sessionId === projection.resolved.sessionId &&
      fact.sessionKey === projection.resolved.sessionKey &&
      fact.agentId === projection.resolved.agentId &&
      fact.sourceIdempotencyKey === user.sourceKey &&
      asOptionalRecord(message?.["__openclaw"])?.runId === (fact.executionRunId ?? fact.runId) &&
      !completions.has(fact.messageId)
    ) {
      completions.set(fact.messageId, fact);
    }
    if (completions.size === users.size) {
      break;
    }
  }
  return [...completions.values()];
}
