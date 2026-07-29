import { runWithGatewayIndependentRootWorkContinuation } from "../process/gateway-work-admission.js";
import type { createSubagentRegistryLifecycleCommon } from "./subagent-registry-lifecycle-common.js";
import type {
  SubagentRegistryLifecycleParams,
  SubagentRegistryLifecycleState,
} from "./subagent-registry-lifecycle-contracts.js";
import type { createSubagentRegistryLifecycleDelivery } from "./subagent-registry-lifecycle-delivery.js";
import type { RequesterSettleWakeState, SubagentRunRecord } from "./subagent-registry.types.js";

type RequesterSettleWakeBatchState =
  import("./subagent-announce.requester-settle-wake.js").RequesterSettleWakeBatchState;
type RequesterSettleWakeResolution =
  import("./subagent-announce.requester-settle-wake.js").RequesterSettleWakeResolution;

export function createSubagentRegistryLifecycleRequesterWake(
  params: SubagentRegistryLifecycleParams,
  lifecycleState: SubagentRegistryLifecycleState,
  common: ReturnType<typeof createSubagentRegistryLifecycleCommon>,
  delivery: ReturnType<typeof createSubagentRegistryLifecycleDelivery>,
) {
  const {
    pendingRequesterSettleWakeRearms,
    scheduledRequesterSettleWakeRuns,
    scheduledRequesterSettleWakeTimers,
  } = lifecycleState;
  const { buildSafeLifecycleErrorMeta, maskRunId, maskSessionKey } = common;

  const transitionRequesterSettleWakeBatch = (
    runIds: readonly string[],
    state: RequesterSettleWakeBatchState,
  ) => {
    const entries = runIds
      .map((runId) => params.runs.get(runId))
      .filter(
        (entry): entry is SubagentRunRecord =>
          Boolean(entry?.requesterSettleWake) &&
          entry?.requesterSettleWake?.rearmGeneration === state.rearmGeneration,
      );
    const previousStates = entries.map((entry) => structuredClone(entry.requesterSettleWake));
    for (const entry of entries) {
      entry.requesterSettleWake = {
        ...state,
        ...(entry.requesterSettleWake?.retireAfterSettle === true
          ? { retireAfterSettle: true }
          : {}),
      };
    }
    try {
      params.persistOrThrow();
    } catch (error) {
      entries.forEach((entry, index) => {
        entry.requesterSettleWake = previousStates[index];
      });
      throw error;
    }
  };

  const completeRequesterSettleWakeBatch = (
    runIds: readonly string[],
    rearmGeneration?: number,
    resolution?: RequesterSettleWakeResolution,
  ) => {
    const entries = runIds
      .map((runId) => [runId, params.runs.get(runId)] as const)
      .filter(
        (pair): pair is readonly [string, SubagentRunRecord] =>
          Boolean(pair[1]?.requesterSettleWake) &&
          pair[1]?.requesterSettleWake?.rearmGeneration === rearmGeneration,
      );
    const requesterSessionKeys = new Set(entries.map(([, entry]) => entry.requesterSessionKey));
    const previousStates = entries.map(([, entry]) => ({
      requesterSettleWake: structuredClone(entry.requesterSettleWake),
      retireAfterRequesterTurn: entry.retireAfterRequesterTurn,
      delivery: structuredClone(entry.delivery),
    }));
    const resolvedEntries = entries
      .map(([, entry]) => entry)
      .filter(
        (entry) =>
          entry.expectsCompletionMessage === true &&
          entry.delivery?.status !== "delivered" &&
          (resolution?.status === "delivered" || resolution?.status === "failed"),
      );
    if (resolution?.status === "delivered" || resolution?.status === "failed") {
      for (const entry of resolvedEntries) {
        delivery.reconcileSubagentTaskAfterRequesterSettle(entry, resolution);
      }
    }
    for (const entry of resolvedEntries) {
      delivery.clearPendingFinalDelivery(entry);
      const state = entry.delivery ?? (entry.delivery = { status: "pending" });
      if (resolution?.status === "delivered") {
        state.status = "delivered";
        state.deliveredAt = Date.now();
        state.announcedAt ??= state.deliveredAt;
        state.lastError = undefined;
      } else if (resolution?.status === "failed") {
        state.status = "failed";
        state.lastError = resolution.error ?? "requester settle wake failed";
      }
    }
    for (const [runId, entry] of entries) {
      if (entry.requesterTurnRunId) {
        entry.retireAfterRequesterTurn =
          entry.retireAfterRequesterTurn === true ||
          entry.requesterSettleWake?.retireAfterSettle === true
            ? true
            : undefined;
        entry.requesterSettleWake = undefined;
      } else if (entry.requesterSettleWake?.retireAfterSettle === true) {
        params.runs.delete(runId);
      } else {
        entry.requesterSettleWake = undefined;
      }
    }
    try {
      params.persistOrThrow();
    } catch (error) {
      entries.forEach(([runId, entry], index) => {
        const previous = previousStates[index];
        params.runs.set(runId, entry);
        entry.requesterSettleWake = previous?.requesterSettleWake;
        entry.retireAfterRequesterTurn = previous?.retireAfterRequesterTurn;
        entry.delivery = previous?.delivery;
      });
      throw error;
    }
    for (const [runId, entry] of entries) {
      const retryTimer = scheduledRequesterSettleWakeTimers.get(runId);
      if (retryTimer) {
        clearTimeout(retryTimer);
        scheduledRequesterSettleWakeTimers.delete(runId);
      }
      if (entry.requesterSettleWake === undefined || !params.runs.has(runId)) {
        params.resumedRuns.delete(runId);
        params.clearPendingLifecycleError(runId);
      }
    }
    for (const [runId, entry] of params.runs) {
      if (entry.requesterSettleWake && requesterSessionKeys.has(entry.requesterSessionKey)) {
        scheduleRequesterSettleWake(runId, entry);
      }
    }
  };

  const markRequesterSettleWakePending = (
    entry: SubagentRunRecord,
    options?: { retireAfterSettle?: boolean },
  ) => {
    const existing = entry.requesterSettleWake;
    entry.requesterSettleWake = {
      status: existing?.status ?? "pending",
      attemptCount: existing?.attemptCount ?? 0,
      ...(existing?.replayCount !== undefined ? { replayCount: existing.replayCount } : {}),
      ...(existing?.nextAttemptAt !== undefined ? { nextAttemptAt: existing.nextAttemptAt } : {}),
      ...(existing?.batchRunIds ? { batchRunIds: [...existing.batchRunIds] } : {}),
      ...(existing?.requesterYieldBatch === true ? { requesterYieldBatch: true } : {}),
      ...(existing?.afterRequesterYield === true ? { afterRequesterYield: true } : {}),
      ...(existing?.rearmGeneration !== undefined
        ? { rearmGeneration: existing.rearmGeneration }
        : {}),
      ...(existing?.lastError !== undefined ? { lastError: existing.lastError } : {}),
      ...(existing?.retireAfterSettle === true || options?.retireAfterSettle === true
        ? { retireAfterSettle: true }
        : {}),
    } satisfies RequesterSettleWakeState;
  };

  const persistRequesterSettleWakePending = (
    entry: SubagentRunRecord,
    options?: { cleanupCompletedAt?: number; retireAfterSettle?: boolean },
  ) => {
    const previousCleanupCompletedAt = entry.cleanupCompletedAt;
    const previousWake = structuredClone(entry.requesterSettleWake);
    if (options?.cleanupCompletedAt !== undefined) {
      entry.cleanupCompletedAt = options.cleanupCompletedAt;
    }
    markRequesterSettleWakePending(entry, options);
    try {
      params.persistOrThrow();
    } catch (error) {
      entry.cleanupCompletedAt = previousCleanupCompletedAt;
      entry.requesterSettleWake = previousWake;
      throw error;
    }
  };

  // Once a child reaches a terminal settle, let the announce layer decide
  // whether its requester's batch has fully drained and, if so, wake the
  // registry-less top-level requester to synthesize. Settle bookkeeping never
  // blocks on the wake, but the wake must run as tracked root work: a live
  // cleanup parent reserves the root synchronously, so restart or suspend
  // cannot reach quiescence between scheduling and the wake's gateway turn.
  // Failures are logged only.
  function scheduleRequesterSettleWakeRetry(runId: string, entry: SubagentRunRecord): void {
    const nextAttemptAt = entry.requesterSettleWake?.nextAttemptAt;
    if (
      nextAttemptAt === undefined ||
      nextAttemptAt <= Date.now() ||
      scheduledRequesterSettleWakeTimers.has(runId)
    ) {
      return;
    }
    const timer = setTimeout(
      () => {
        scheduledRequesterSettleWakeTimers.delete(runId);
        const current = params.runs.get(runId);
        if (current === entry && current.requesterSettleWake) {
          scheduleRequesterSettleWake(runId, current);
        }
      },
      Math.max(0, nextAttemptAt - Date.now()),
    );
    timer.unref?.();
    scheduledRequesterSettleWakeTimers.set(runId, timer);
  }

  function scheduleRequesterSettleWake(runId: string, entry: SubagentRunRecord): void {
    const requesterSessionKey = entry.requesterSessionKey?.trim();
    if (
      entry.collect ||
      !requesterSessionKey ||
      scheduledRequesterSettleWakeRuns.has(runId) ||
      scheduledRequesterSettleWakeTimers.has(runId)
    ) {
      return;
    }
    if ((entry.requesterSettleWake?.nextAttemptAt ?? 0) > Date.now()) {
      scheduleRequesterSettleWakeRetry(runId, entry);
      return;
    }
    scheduledRequesterSettleWakeRuns.add(runId);
    void runWithGatewayIndependentRootWorkContinuation(() =>
      params.maybeWakeRequesterAfterAllChildrenSettled({
        requesterSessionKey,
        requesterOrigin: entry.requesterOrigin,
        settledEntry: entry,
        transitionBatch: transitionRequesterSettleWakeBatch,
        completeBatch: completeRequesterSettleWakeBatch,
      }),
    )
      .catch((error: unknown) => {
        params.warn("requester settle wake failed", {
          error: buildSafeLifecycleErrorMeta(error),
          runId: maskRunId(runId),
          requesterSessionKey: maskSessionKey(requesterSessionKey),
        });
      })
      .finally(() => {
        scheduledRequesterSettleWakeRuns.delete(runId);
        const wasRearmedWhileRunning = pendingRequesterSettleWakeRearms.delete(runId);
        const current = params.runs.get(runId);
        if (current === entry && current.requesterSettleWake) {
          if (wasRearmedWhileRunning) {
            // A requester yield can freeze a delivered batch while this run is
            // resolving its earlier no-wake decision. Admit that durable update now.
            scheduleRequesterSettleWake(runId, current);
          } else {
            scheduleRequesterSettleWakeRetry(runId, current);
          }
        }
      });
  }

  return {
    markRequesterSettleWakePending,
    persistRequesterSettleWakePending,
    scheduleRequesterSettleWake,
  };
}
