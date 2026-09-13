import { readStringParam } from "openclaw/plugin-sdk/param-readers";
import { asOptionalRecord, asSafeIntegerInRange } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
  estimateToolResultTextChars,
} from "openclaw/plugin-sdk/text-utility-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import { isAbsoluteLocalCodexUnixUrl, readCodexPluginConfig } from "./app-server/config-parsing.js";
import type { CodexQueuedSubmission } from "./app-server/protocol-thread-queue.js";
import { isJsonObject } from "./app-server/protocol.js";
import type { codexControlRequest, CodexControlRequestOptions } from "./command-rpc.js";

export const QueueParamsSchema = Type.Object(
  {
    action: Type.Literal("queue"),
    thread_id: Type.String({ minLength: 1 }),
    text: Type.String({
      minLength: 1,
      description: "Attributed text to add to the selected native Codex task queue.",
    }),
    client_user_message_id: Type.String({
      minLength: 1,
      description:
        "Caller-chosen logical correlation id. Native Codex inserts a new row on every call; this is not a deduplication key.",
    }),
  },
  { additionalProperties: false },
);

export const QueueListParamsSchema = Type.Object(
  {
    action: Type.Literal("queue_list"),
    thread_id: Type.String({ minLength: 1 }),
    cursor: Type.Optional(Type.String({ minLength: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  },
  { additionalProperties: false },
);

function readQueuePolicy(pluginConfig: unknown, action: "queue" | "queue_list") {
  const rawSupervision = asOptionalRecord(asOptionalRecord(pluginConfig)?.supervision);
  if (rawSupervision?.enabled !== true) {
    throw new Error("Codex native queue controls require enabled supervision.");
  }
  const rawEndpoint =
    typeof rawSupervision.queueEndpoint === "string"
      ? rawSupervision.queueEndpoint.trim()
      : undefined;
  if (!isAbsoluteLocalCodexUnixUrl(rawEndpoint)) {
    throw new Error(
      "Codex native queue controls require a configured absolute local unix endpoint.",
    );
  }
  const supervision = readCodexPluginConfig(pluginConfig).supervision;
  if (supervision?.enabled !== true || supervision.queueEndpoint !== rawEndpoint) {
    throw new Error("Codex native queue supervision config is invalid.");
  }
  if (action === "queue" && supervision.allowQueueControls !== true) {
    throw new Error("Codex native queue writes are disabled for this codex plugin config.");
  }
  if (action === "queue_list" && supervision.allowRawTranscripts !== true) {
    throw new Error("Codex native queue readback requires raw transcript access.");
  }
  return { endpoint: rawEndpoint };
}

function isQueuedSubmission(value: unknown): value is CodexQueuedSubmission {
  return (
    isJsonObject(value) &&
    typeof value.id === "string" &&
    Boolean(value.id.trim()) &&
    Array.isArray(value.input) &&
    value.input.every((entry) => isJsonObject(entry) && typeof entry.type === "string") &&
    typeof value.clientUserMessageId === "string" &&
    Boolean(value.clientUserMessageId.trim())
  );
}

function readQueuedSubmissionPage(
  value: unknown,
  limit: number,
  cursor: string | undefined,
): { data: CodexQueuedSubmission[]; nextCursor: string | null } {
  if (
    !isJsonObject(value) ||
    !Array.isArray(value.data) ||
    value.data.length > limit ||
    !value.data.every(isQueuedSubmission) ||
    (value.nextCursor !== undefined &&
      value.nextCursor !== null &&
      (typeof value.nextCursor !== "string" ||
        !value.nextCursor.trim() ||
        value.nextCursor === cursor))
  ) {
    throw new Error("Codex app-server returned an invalid native queue page.");
  }
  return { data: value.data, nextCursor: value.nextCursor ?? null };
}

export async function executeNativeThreadQueueAction(options: {
  action: "queue" | "queue_list";
  params: Record<string, unknown>;
  getPluginConfig: () => unknown;
  baseRequestOptions: () => CodexControlRequestOptions;
  request?: typeof codexControlRequest;
}) {
  const { action, params } = options;
  const threadId = readStringParam(params, "thread_id", {
    required: true,
    label: "thread_id",
  });
  const request = options.request ?? (await import("./command-rpc.js")).codexControlRequest;
  const { resolveCodexSupervisionAppServerRuntimeOptions } =
    await import("./app-server/config-runtime.js");
  const neutralStart = resolveCodexSupervisionAppServerRuntimeOptions({
    pluginConfig: { supervision: { enabled: true } },
  }).start;
  const queueRequestOptions = (endpoint: string): CodexControlRequestOptions => ({
    ...options.baseRequestOptions(),
    authProfileId: null,
    startOptions: {
      ...neutralStart,
      transport: "unix",
      homeScope: "user",
      url: endpoint,
      authToken: undefined,
      headers: {},
    },
  });

  if (action === "queue") {
    const text = readStringParam(params, "text", { required: true, label: "text", trim: false });
    if (!text.trim()) {
      throw new Error("text required");
    }
    const clientUserMessageId = readStringParam(params, "client_user_message_id", {
      required: true,
      label: "client_user_message_id",
    });
    const liveConfig = options.getPluginConfig();
    const { endpoint } = readQueuePolicy(liveConfig, action);
    let response: unknown;
    try {
      response = await request(
        liveConfig,
        CODEX_CONTROL_METHODS.queueThread,
        {
          threadId,
          input: [{ type: "text", text, text_elements: [] }],
          clientUserMessageId,
        },
        queueRequestOptions(endpoint),
      );
    } catch (error) {
      const {
        isCodexAppServerIndeterminateRequestCancellationError,
        isCodexAppServerIndeterminateTransportError,
      } = await import("./app-server/client.js");
      if (
        isCodexAppServerIndeterminateRequestCancellationError(error) ||
        isCodexAppServerIndeterminateTransportError(error)
      ) {
        throw new Error(
          `Codex native queue acknowledgment is uncertain for thread ${threadId} and client_user_message_id ${clientUserMessageId}. Do not resend automatically; reconcile with queue_list or native transcript reads before deciding whether to enqueue again.`,
          { cause: error },
        );
      }
      throw error;
    }
    if (
      !isJsonObject(response) ||
      !isQueuedSubmission(response.queuedSubmission) ||
      response.queuedSubmission.clientUserMessageId !== clientUserMessageId
    ) {
      throw new Error("Codex app-server returned an invalid thread/queue/add response.");
    }
    return jsonResult({
      action,
      status: "queued",
      threadId,
      queuedSubmission: response.queuedSubmission,
    });
  }

  const cursor = readStringParam(params, "cursor", { trim: false });
  if (cursor !== undefined && !cursor.trim()) {
    throw new Error("Codex queue cursor must be a nonempty native continuation cursor.");
  }
  const requestedLimit = asSafeIntegerInRange(params.limit, { min: 1, max: 50 });
  if (params.limit !== undefined && requestedLimit === undefined) {
    throw new Error("Codex queue limit must be an integer from 1 to 50.");
  }
  const { sanitizeToolResult } = await import("openclaw/plugin-sdk/agent-harness-runtime");
  let limit = requestedLimit ?? 10;
  for (;;) {
    const liveConfig = options.getPluginConfig();
    const { endpoint } = readQueuePolicy(liveConfig, action);
    const response = await request(
      liveConfig,
      CODEX_CONTROL_METHODS.listThreadQueue,
      { threadId, limit, ...(cursor ? { cursor } : {}) },
      queueRequestOptions(endpoint),
    );
    const page = readQueuedSubmissionPage(response, limit, cursor);
    const payload = { threadId, data: page.data, nextCursor: page.nextCursor };
    const text = JSON.stringify(payload, null, 2);
    if (
      estimateToolResultTextChars(text) <= DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS &&
      estimateToolResultTextChars(sanitizeToolResult(text)) <= DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS
    ) {
      return jsonResult(payload);
    }
    if (page.data.length <= 1) {
      throw new Error(
        "A complete Codex queued submission or its continuation metadata exceeds the safe page size. No submissions were returned and the cursor was not advanced; inspect the queue in Codex.",
      );
    }
    limit = Math.max(1, Math.floor(page.data.length / 2));
  }
}
