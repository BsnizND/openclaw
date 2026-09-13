import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import { createClientHarness } from "./app-server/test-support.js";
import { executeNativeThreadQueueAction } from "./native-thread-queue.js";

const sharedClientMocks = vi.hoisted(() => ({
  createIsolatedCodexAppServerClient: vi.fn(),
  getLeasedSharedCodexAppServerClient: vi.fn(),
  isCodexAppServerStartSelectionChangedError: vi.fn(() => false),
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
  retireSharedCodexAppServerClientIfCurrent: vi.fn(),
}));

vi.mock("./app-server/shared-client.js", () => sharedClientMocks);

const QUEUE_ENDPOINT = "unix:///tmp/codex-app-server-control.sock";
const CHANGED_QUEUE_ENDPOINT = "unix:///tmp/codex-app-server-other.sock";

function queueConfig(overrides: Record<string, unknown> = {}) {
  return {
    supervision: {
      enabled: true,
      allowQueueControls: true,
      allowRawTranscripts: true,
      queueEndpoint: QUEUE_ENDPOINT,
      ...overrides,
    },
  };
}

function queueParams(action: "queue" | "queue_list") {
  return action === "queue"
    ? {
        thread_id: "thread-deadline",
        text: "Jay: one attributed contribution",
        client_user_message_id: "logical-deadline",
      }
    : { thread_id: "thread-deadline" };
}

function runQueueAction(options: {
  action?: "queue" | "queue_list";
  getPluginConfig: () => unknown;
  baseRequestOptions?: () => {
    timeoutMs?: number;
    assertCurrent?: () => void;
  };
}) {
  const action = options.action ?? "queue";
  return executeNativeThreadQueueAction({
    action,
    params: queueParams(action),
    getPluginConfig: options.getPluginConfig,
    baseRequestOptions: options.baseRequestOptions ?? (() => ({ timeoutMs: 50 })),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("native Codex queue request integration", () => {
  beforeEach(() => {
    for (const mock of Object.values(sharedClientMocks)) {
      mock.mockReset();
    }
    sharedClientMocks.isCodexAppServerStartSelectionChangedError.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: "queue supervision",
      action: "queue" as const,
      nextConfig: queueConfig({ enabled: false }),
      error: "require enabled supervision",
    },
    {
      name: "the queue write grant",
      action: "queue" as const,
      nextConfig: queueConfig({ allowQueueControls: false }),
      error: "queue writes are disabled",
    },
    {
      name: "the admitted queue endpoint",
      action: "queue" as const,
      nextConfig: queueConfig({ queueEndpoint: CHANGED_QUEUE_ENDPOINT }),
      error: "queue endpoint changed",
    },
    {
      name: "raw queue readback",
      action: "queue_list" as const,
      nextConfig: queueConfig({ allowRawTranscripts: false }),
      error: "queue readback requires raw transcript access",
    },
    {
      name: "the admitted readback endpoint",
      action: "queue_list" as const,
      nextConfig: queueConfig({ queueEndpoint: CHANGED_QUEUE_ENDPOINT }),
      error: "queue endpoint changed",
    },
  ])(
    "rechecks $name after acquisition and before physical send",
    async ({ action, nextConfig, error }) => {
      const harness = createClientHarness();
      const acquisition = deferred<typeof harness.client>();
      const acquisitionStarted = deferred<void>();
      const inheritedGuard = vi.fn();
      let config: unknown = queueConfig();
      sharedClientMocks.getLeasedSharedCodexAppServerClient.mockImplementation(() => {
        acquisitionStarted.resolve();
        return acquisition.promise;
      });

      const result = runQueueAction({
        action,
        getPluginConfig: () => config,
        baseRequestOptions: () => ({ timeoutMs: 5_000, assertCurrent: inheritedGuard }),
      });
      await acquisitionStarted.promise;
      expect(sharedClientMocks.getLeasedSharedCodexAppServerClient).toHaveBeenCalledOnce();
      config = nextConfig;
      acquisition.resolve(harness.client);
      const observed = await result.catch((caught: unknown) => caught);

      expect(observed).toBeInstanceOf(Error);
      expect((observed as Error).message).toContain(error);
      expect((observed as Error).message).not.toContain("acknowledgment is uncertain");
      expect(inheritedGuard).toHaveBeenCalled();
      expect(harness.writes).toHaveLength(0);
      expect(sharedClientMocks.releaseLeasedSharedCodexAppServerClient).toHaveBeenCalledOnce();
    },
  );

  it("preserves an inherited caller guard before the physical queue send", async () => {
    const harness = createClientHarness();
    const guardFailure = new Error("admitted owner is no longer current");
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValue(harness.client);

    const observed = await runQueueAction({
      getPluginConfig: () => queueConfig(),
      baseRequestOptions: () => ({
        timeoutMs: 50,
        assertCurrent: () => {
          throw guardFailure;
        },
      }),
    }).catch((error: unknown) => error);

    expect(observed).toMatchObject({
      message: guardFailure.message,
      cause: guardFailure,
    });
    expect((observed as Error).message).not.toContain("acknowledgment is uncertain");
    expect(harness.writes).toHaveLength(0);
  });

  it("classifies an unanswered physical write's actual outer timer expiry as uncertain", async () => {
    const harness = createClientHarness();
    let config: unknown = queueConfig();
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValue(harness.client);

    const result = runQueueAction({ getPluginConfig: () => config });
    await harness.waitForWrite(0);
    config = queueConfig({ allowQueueControls: false });
    const observed = await result.catch((error: unknown) => error);

    expect(observed).toBeInstanceOf(Error);
    expect((observed as Error).message).toContain("acknowledgment is uncertain");
    expect((observed as Error).message).toContain("thread-deadline");
    expect((observed as Error).message).toContain("logical-deadline");
    expect((observed as Error).message).toContain("Do not resend");
    expect(observed).toMatchObject({
      cause: expect.objectContaining({
        message: "codex app-server thread/queue/add timed out",
        cause: expect.objectContaining({
          code: "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED",
          reason: "timed out",
          mayHaveWritten: true,
        }),
      }),
    });
    expect(harness.writes).toHaveLength(1);
    expect(sharedClientMocks.releaseLeasedSharedCodexAppServerClient).toHaveBeenCalledOnce();
  });

  it("preserves a native RPC rejection after one physical queue write", async () => {
    const harness = createClientHarness({
      onWrite: (line, send) => {
        const request = JSON.parse(line) as { id: unknown };
        send({
          id: request.id,
          error: { code: -32600, message: "thread not loaded: thread-deadline" },
        });
      },
    });
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValue(harness.client);

    const observed = await runQueueAction({
      getPluginConfig: () => queueConfig(),
    }).catch((error: unknown) => error);

    expect(observed).toMatchObject({
      code: -32600,
      message: "thread not loaded: thread-deadline",
    });
    expect((observed as Error).message).not.toContain("acknowledgment is uncertain");
    expect(harness.writes).toHaveLength(1);
  });

  it("classifies a deadline-wrapped post-write transport failure as uncertain", async () => {
    let now = 1_000;
    const harness = createClientHarness({
      onWrite: () => {
        now = 1_100;
        queueMicrotask(() => {
          harness.process.stdin.emit("error", new Error("control socket closed"));
        });
      },
    });
    vi.spyOn(Date, "now").mockImplementation(() => now);
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValue(harness.client);

    const observed = await runQueueAction({
      getPluginConfig: () => queueConfig(),
    }).catch((error: unknown) => error);

    expect(observed).toBeInstanceOf(Error);
    expect((observed as Error).message).toContain("acknowledgment is uncertain");
    expect((observed as Error).message).toContain("thread-deadline");
    expect((observed as Error).message).toContain("logical-deadline");
    expect((observed as Error).message).toContain("Do not resend");
    expect(observed).toMatchObject({
      cause: expect.objectContaining({
        message: "codex app-server thread/queue/add timed out",
        cause: expect.objectContaining({
          code: "CODEX_APP_SERVER_REQUEST_TRANSPORT_INDETERMINATE",
          mayHaveWritten: true,
        }),
      }),
    });
    expect(harness.writes).toHaveLength(1);
    expect(JSON.parse(harness.writes[0] ?? "null")).toMatchObject({
      method: CODEX_CONTROL_METHODS.queueThread,
      params: {
        threadId: "thread-deadline",
        clientUserMessageId: "logical-deadline",
      },
    });
    expect(sharedClientMocks.getLeasedSharedCodexAppServerClient).toHaveBeenCalledOnce();
    expect(sharedClientMocks.releaseLeasedSharedCodexAppServerClient).toHaveBeenCalledOnce();
  });
});
