// Per-call realtime instructions through the public voice-call adapters.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPrivateCallRecord,
  createRuntimeStub,
  expectRedactedVoiceCallStatus,
  firstRespondCall,
  setup,
  type TestGatewayHandler,
} from "./index.test-harness.js";
import type { VoiceCallRuntime } from "./runtime-entry.js";

let runtimeStub: VoiceCallRuntime;
vi.mock("./runtime-entry.js", () => ({
  createVoiceCallRuntime: vi.fn(async () => runtimeStub),
}));
import { createVoiceCallRuntime } from "./runtime-entry.js";

describe("voice-call per-call realtime instructions", () => {
  beforeEach(() => {
    runtimeStub = createRuntimeStub();
    vi.mocked(createVoiceCallRuntime).mockReset();
    vi.mocked(createVoiceCallRuntime).mockImplementation(async () => runtimeStub);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.voice-call.runtimeCoordinator")
    ];
  });

  it("returns redacted active call status list", async () => {
    const call = createPrivateCallRecord();
    runtimeStub.manager.getActiveCalls = vi.fn(() => [call]);
    const { methods } = setup({ provider: "mock" });
    const handler = methods.get("voicecall.status") as TestGatewayHandler | undefined;
    const respond = vi.fn();

    await handler?.({ params: {}, respond });

    const [ok, payload] = firstRespondCall(respond);
    expect(ok).toBe(true);
    expect(payload?.found).toBe(true);
    expect(payload?.capabilities).toEqual({ perCallRealtimeInstructions: true });
    const calls = (payload?.calls as unknown[] | undefined) ?? [];
    expect(calls).toHaveLength(1);
    expectRedactedVoiceCallStatus(calls[0]);
  });

  it.each(["voicecall.initiate", "voicecall.start"])(
    "forwards private realtime instructions through %s without changing the opening",
    async (method) => {
      const { methods } = setup({ provider: "mock" });
      const handler = methods.get(method) as TestGatewayHandler;
      const initiateCall = vi.spyOn(runtimeStub.manager, "initiateCall");
      const respond = vi.fn();
      await handler({
        params: {
          to: "+15550001234",
          message: "Public opening",
          mode: "conversation",
          realtimeInstructions: "Private task brief",
        },
        respond,
      });
      expect(firstRespondCall(respond)[0]).toBe(true);
      expect(initiateCall).toHaveBeenCalledWith(
        "+15550001234",
        undefined,
        expect.objectContaining({
          message: "Public opening",
          realtimeInstructions: "Private task brief",
        }),
      );
    },
  );

  it.each([
    { label: "number", realtimeInstructions: 42 },
    { label: "null", realtimeInstructions: null },
    { label: "empty", realtimeInstructions: "" },
    { label: "whitespace", realtimeInstructions: "   " },
    { label: "oversize", realtimeInstructions: "x".repeat(20_001) },
  ])(
    "rejects malformed realtime instructions before manager admission ($label)",
    async ({ realtimeInstructions }) => {
      const { methods } = setup({ provider: "mock" });
      const handler = methods.get("voicecall.initiate") as TestGatewayHandler;
      const initiateCall = vi.spyOn(runtimeStub.manager, "initiateCall");
      const respond = vi.fn();
      await handler({ params: { message: "Public opening", realtimeInstructions }, respond });
      expect(firstRespondCall(respond)[0]).toBe(false);
      expect(initiateCall).not.toHaveBeenCalled();
    },
  );

  it.each([
    { action: "initiate_call", message: "Hello", realtimeInstructions: "Private task brief" },
    { message: "Hello", realtimeInstructions: "Private task brief" },
  ])("freezes invocation context for tool-created calls ($action)", async (params) => {
    const initiateCall = vi.spyOn(runtimeStub.manager, "initiateCall");
    const { tools } = setup(
      { provider: "mock" },
      { agentId: "support", sessionKey: "agent:support:discord:channel:general" },
    );
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<unknown>;
    };

    await tool.execute("id", {
      ...params,
      to: "+15550001234",
      requesterSessionKey: "agent:spoofed:requester",
      sessionKey: "agent:support:voice:call-1",
    });

    expect(initiateCall).toHaveBeenCalledWith(
      "+15550001234",
      "agent:support:voice:call-1",
      expect.objectContaining({
        agentId: "support",
        message: "Hello",
        realtimeInstructions: "Private task brief",
        requesterSessionKey: "agent:support:discord:channel:general",
      }),
    );
  });
});
