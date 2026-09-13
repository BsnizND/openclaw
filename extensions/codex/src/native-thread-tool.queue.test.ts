import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import { CodexAppServerRpcError } from "./app-server/rpc-error.js";
import {
  registerCodexTestSessionIdentity,
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./app-server/session-binding.test-helpers.js";
import { createCodexThreadsTool } from "./native-thread-tool.js";

const QUEUE_ENDPOINT = "unix:///tmp/codex-app-server-control.sock";
const QUEUE_TEXT = "Jay: I found a concrete edge case for this task.";
const QUEUE_INPUT = [
  {
    type: "text",
    text: QUEUE_TEXT,
    text_elements: [],
  },
];

function queueConfig(overrides?: Record<string, unknown>) {
  return {
    appServer: { homeScope: "user" },
    supervision: {
      enabled: true,
      allowRawTranscripts: true,
      allowQueueControls: true,
      queueEndpoint: QUEUE_ENDPOINT,
      ...overrides,
    },
  };
}

describe("native Codex thread queue controls", () => {
  let root: string;
  let sessionFile: string;

  async function withFixture(run: () => void | Promise<void>): Promise<void> {
    await withTempDir("openclaw-codex-thread-queue-", async (tempRoot) => {
      root = tempRoot;
      sessionFile = path.join(root, "sessions", "session-id.jsonl");
      await fs.mkdir(path.dirname(sessionFile), { recursive: true });
      await fs.writeFile(sessionFile, "");
      resetCodexTestBindingStore();
      registerCodexTestSessionIdentity(
        "session-id",
        "session-id",
        "agent:main:telegram:direct:owner",
      );
      await run();
    });
  }

  function createTool(params?: {
    owner?: boolean;
    pluginConfig?: unknown;
    getPluginConfig?: () => unknown;
    request?: ReturnType<typeof vi.fn>;
  }) {
    const context: OpenClawPluginToolContext = {
      config: {},
      agentId: "main",
      agentDir: path.join(root, "agent"),
      workspaceDir: path.join(root, "workspace"),
      sessionKey: "agent:main:telegram:direct:owner",
      sessionId: "session-id",
      senderIsOwner: params?.owner ?? true,
    };
    const runtime = createPluginRuntimeMock({
      agent: {
        session: {
          getSessionEntry: () => ({
            sessionId: "session-id",
            sessionFile,
            updatedAt: Date.now(),
          }),
          resolveStorePath: () => path.join(root, "sessions", "sessions.json"),
        },
      },
    });
    const pluginConfig = params?.pluginConfig ?? queueConfig();
    return createCodexThreadsTool({
      bindingStore: testCodexAppServerBindingStore,
      context,
      runtime,
      getPluginConfig: params?.getPluginConfig ?? (() => pluginConfig),
      request: params?.request as never,
    });
  }

  it("admits queue controls only for an existing owner run", () =>
    withFixture(() => {
      const request = vi.fn();

      expect(createTool({ owner: false, request })).toBeNull();
      expect(request).not.toHaveBeenCalled();
    }));

  it.each([
    {
      name: "supervision was disabled",
      config: queueConfig({ enabled: false }),
      error: "Codex native queue controls require enabled supervision",
    },
    {
      name: "the endpoint was removed",
      config: queueConfig({ queueEndpoint: undefined }),
      error: "Codex native queue controls require a configured absolute local unix endpoint",
    },
    {
      name: "the endpoint became non-local",
      config: queueConfig({ queueEndpoint: "unix://remote-host/tmp/control.sock" }),
      error: "Codex native queue controls require a configured absolute local unix endpoint",
    },
    {
      name: "the queue grant was revoked",
      config: queueConfig({ allowQueueControls: false }),
      error: "Codex native queue writes are disabled",
    },
    {
      name: "only the old write grant remained",
      config: queueConfig({ allowQueueControls: false, allowWriteControls: true }),
      error: "Codex native queue writes are disabled",
    },
  ])("rechecks current queue admission when $name", ({ config, error }) =>
    withFixture(async () => {
      let pluginConfig: unknown = queueConfig();
      const request = vi.fn();
      const tool = createTool({ request, getPluginConfig: () => pluginConfig });
      pluginConfig = config;

      await expect(
        tool?.execute("queue-revoked", {
          action: "queue",
          thread_id: "thread-1",
          text: QUEUE_TEXT,
          client_user_message_id: "logical-1",
        }),
      ).rejects.toThrow(error);
      expect(request).not.toHaveBeenCalled();
    }),
  );

  it("keeps queue-only permission separate from existing native mutations", () =>
    withFixture(async () => {
      const request = vi.fn();
      const tool = createTool({
        pluginConfig: queueConfig({ allowWriteControls: false }),
        request,
      });

      await expect(
        tool?.execute("rename-with-queue-only", {
          action: "rename",
          thread_id: "thread-1",
          name: "Should not change",
        }),
      ).rejects.toThrow("Codex native thread mutations are disabled");
      expect(request).not.toHaveBeenCalled();
    }));

  it("queues exactly one attributed text submission through the configured endpoint", () =>
    withFixture(async () => {
      const pluginConfig = {
        appServer: {
          transport: "websocket",
          homeScope: "agent",
          url: "ws://127.0.0.1:45678",
        },
        supervision: {
          enabled: true,
          allowQueueControls: true,
          queueEndpoint: QUEUE_ENDPOINT,
        },
      };
      const originalConfig = structuredClone(pluginConfig);
      const queuedSubmission = {
        id: "queued-1",
        input: QUEUE_INPUT,
        clientUserMessageId: "logical-1",
      };
      const request = vi.fn(async () => ({ queuedSubmission }));
      const tool = createTool({ pluginConfig, request });

      const result = await tool?.execute("queue-1", {
        action: "queue",
        thread_id: "thread-1",
        text: QUEUE_TEXT,
        client_user_message_id: "logical-1",
      });

      expect(request).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledWith(
        pluginConfig,
        CODEX_CONTROL_METHODS.queueThread,
        {
          threadId: "thread-1",
          input: QUEUE_INPUT,
          clientUserMessageId: "logical-1",
        },
        expect.objectContaining({
          authProfileId: null,
          startOptions: expect.objectContaining({
            transport: "unix",
            homeScope: "user",
            url: QUEUE_ENDPOINT,
          }),
        }),
      );
      expect(result?.details).toEqual({
        action: "queue",
        status: "queued",
        threadId: "thread-1",
        queuedSubmission,
      });
      expect(pluginConfig).toEqual(originalConfig);
    }));

  it.each([
    new CodexAppServerRpcError(
      { code: -32601, message: "Method not found: thread/queue/add" },
      "thread/queue/add",
    ),
    Object.assign(new Error("connect ENOENT /tmp/missing-control.sock"), { code: "ENOENT" }),
    new CodexAppServerRpcError(
      { code: -32600, message: "thread not found: unknown-thread" },
      "thread/queue/add",
    ),
    new CodexAppServerRpcError(
      { code: -32600, message: "thread is archived: archived-thread" },
      "thread/queue/add",
    ),
    new CodexAppServerRpcError(
      { code: -32600, message: "thread not loaded: unloaded-thread" },
      "thread/queue/add",
    ),
  ])("preserves native queue rejection: $message", (rejection) =>
    withFixture(async () => {
      const request = vi.fn(async () => {
        throw rejection;
      });
      const tool = createTool({ request });

      const observed = await tool
        ?.execute("queue-rejected", {
          action: "queue",
          thread_id: "thread-1",
          text: QUEUE_TEXT,
          client_user_message_id: "logical-rejected",
        })
        .catch((error: unknown) => error);

      expect(observed).toBe(rejection);
      expect(request).toHaveBeenCalledOnce();
    }),
  );

  it.each([
    {
      code: "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED",
      message: "thread/queue/add timed out",
    },
    {
      code: "CODEX_APP_SERVER_REQUEST_TRANSPORT_INDETERMINATE",
      message: "thread/queue/add transport failed after request write: socket closed",
    },
  ])("reports $code as uncertain without retrying", ({ code, message }) =>
    withFixture(async () => {
      const transportError = Object.assign(new Error(message), { code, mayHaveWritten: true });
      const request = vi.fn(async () => {
        throw transportError;
      });
      const tool = createTool({ request });

      const observed = await tool
        ?.execute("queue-uncertain", {
          action: "queue",
          thread_id: "thread-uncertain",
          text: QUEUE_TEXT,
          client_user_message_id: "logical-uncertain",
        })
        .catch((error: unknown) => error);

      expect(observed).toBeInstanceOf(Error);
      expect(observed).toMatchObject({ cause: transportError });
      expect((observed as Error).message).toContain("acknowledgment is uncertain");
      expect((observed as Error).message).toContain("thread-uncertain");
      expect((observed as Error).message).toContain("logical-uncertain");
      expect((observed as Error).message).toContain("Do not resend");
      expect(request).toHaveBeenCalledOnce();
    }),
  );

  it("lists complete queued submissions after queue-write permission is revoked", () =>
    withFixture(async () => {
      let pluginConfig: unknown = queueConfig();
      const page = {
        data: [
          {
            id: "queued-1",
            input: QUEUE_INPUT,
            clientUserMessageId: "logical-1",
          },
        ],
        nextCursor: "queue-page-2",
      };
      const request = vi.fn(async () => page);
      const tool = createTool({ request, getPluginConfig: () => pluginConfig });
      pluginConfig = queueConfig({ allowQueueControls: false });

      const result = await tool?.execute("queue-list-1", {
        action: "queue_list",
        thread_id: "thread-1",
        cursor: "queue-page-1",
        limit: 7,
      });

      expect(request).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledWith(
        pluginConfig,
        CODEX_CONTROL_METHODS.listThreadQueue,
        { threadId: "thread-1", cursor: "queue-page-1", limit: 7 },
        expect.objectContaining({
          authProfileId: null,
          startOptions: expect.objectContaining({
            transport: "unix",
            homeScope: "user",
            url: QUEUE_ENDPOINT,
          }),
        }),
      );
      expect(result?.details).toEqual({
        threadId: "thread-1",
        data: page.data,
        nextCursor: "queue-page-2",
      });
    }));

  it("requires raw transcript access for queue readback", () =>
    withFixture(async () => {
      let pluginConfig: unknown = queueConfig();
      const request = vi.fn();
      const tool = createTool({ request, getPluginConfig: () => pluginConfig });
      pluginConfig = queueConfig({ allowRawTranscripts: false, allowQueueControls: false });

      await expect(
        tool?.execute("queue-list-private", {
          action: "queue_list",
          thread_id: "thread-1",
        }),
      ).rejects.toThrow("Codex native queue readback requires raw transcript access");
      expect(request).not.toHaveBeenCalled();
    }));

  it("rejects a blank queue cursor without restarting pagination", () =>
    withFixture(async () => {
      const request = vi.fn();
      const tool = createTool({ request });

      await expect(
        tool?.execute("queue-list-blank-cursor", {
          action: "queue_list",
          thread_id: "thread-1",
          cursor: "   ",
        }),
      ).rejects.toThrow("Codex queue cursor must be a nonempty native continuation cursor");
      expect(request).not.toHaveBeenCalled();
    }));

  it("shrinks a queue page by rereading the same cursor without slicing entries", () =>
    withFixture(async () => {
      const first = {
        id: "queued-large-1",
        input: [{ type: "text", text: "A".repeat(9_000), text_elements: [] }],
        clientUserMessageId: "logical-large-1",
      };
      const second = {
        id: "queued-large-2",
        input: [{ type: "text", text: "B".repeat(9_000), text_elements: [] }],
        clientUserMessageId: "logical-large-2",
      };
      const request = vi.fn(async (_config, _method, params: { limit: number }) =>
        params.limit === 1
          ? { data: [first], nextCursor: "after-first" }
          : { data: [first, second], nextCursor: "after-second" },
      );
      const tool = createTool({ request });

      const result = await tool?.execute("queue-list-shrink", {
        action: "queue_list",
        thread_id: "thread-1",
        cursor: "queue-anchor",
      });

      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        CODEX_CONTROL_METHODS.listThreadQueue,
        { threadId: "thread-1", cursor: "queue-anchor", limit: 10 },
        expect.anything(),
      );
      expect(request).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        CODEX_CONTROL_METHODS.listThreadQueue,
        { threadId: "thread-1", cursor: "queue-anchor", limit: 1 },
        expect.anything(),
      );
      expect(result?.details).toEqual({
        threadId: "thread-1",
        data: [first],
        nextCursor: "after-first",
      });
    }));

  it("fails without a partial result when one queued submission exceeds the page budget", () =>
    withFixture(async () => {
      const request = vi.fn(async () => ({
        data: [
          {
            id: "queued-oversized",
            input: [{ type: "text", text: "X".repeat(20_000), text_elements: [] }],
            clientUserMessageId: "logical-oversized",
          },
        ],
        nextCursor: "after-oversized",
      }));
      const tool = createTool({ request });

      await expect(
        tool?.execute("queue-list-oversized", {
          action: "queue_list",
          thread_id: "thread-1",
        }),
      ).rejects.toThrow("A complete Codex queued submission");
      expect(request).toHaveBeenCalledOnce();
    }));
});
