import type { JsonObject } from "./protocol-json.js";
import type { CodexUserInput } from "./protocol-user-input.js";

export type CodexQueuedSubmission = {
  id: string;
  input: CodexUserInput[];
  clientUserMessageId: string;
};

export type CodexThreadQueueAddParams = JsonObject & {
  threadId: string;
  input: CodexUserInput[];
  clientUserMessageId: string;
};

export type CodexThreadQueueAddResponse = {
  queuedSubmission: CodexQueuedSubmission;
};

export type CodexThreadQueueListParams = JsonObject & {
  threadId: string;
  cursor?: string | null;
  limit?: number | null;
};

export type CodexThreadQueueListResponse = {
  data: CodexQueuedSubmission[];
  nextCursor?: string | null;
};
