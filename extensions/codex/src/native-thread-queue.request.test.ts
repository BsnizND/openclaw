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

    const observed = await executeNativeThreadQueueAction({
      action: "queue",
      params: {
        thread_id: "thread-deadline",
        text: "Jay: one attributed contribution",
        client_user_message_id: "logical-deadline",
      },
      getPluginConfig: () => ({
        supervision: {
          enabled: true,
          allowQueueControls: true,
          queueEndpoint: QUEUE_ENDPOINT,
        },
      }),
      baseRequestOptions: () => ({ timeoutMs: 50 }),
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
