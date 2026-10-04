// Shared fixture for voice-call Gateway and model-tool registration tests.
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { expect, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import plugin from "./index.js";
import type { VoiceCallRuntime } from "./runtime-entry.js";
import type { CallRecord } from "./src/types.js";

export const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

export type TestGatewayHandler = (ctx: {
  params: Record<string, unknown>;
  client?: { internal?: { pluginRuntimeOwnerId?: string } };
  respond: ReturnType<typeof vi.fn>;
}) => Promise<void>;

export type Registered = {
  methods: Map<string, unknown>;
  methodScopes: Map<string, string | undefined>;
  tools: unknown[];
  service?: Parameters<OpenClawPluginApi["registerService"]>[0];
};
type MockCallSource = {
  mock: {
    calls: ArrayLike<ReadonlyArray<unknown>>;
  };
};
type RespondCall = [
  ok: boolean,
  payload?: Record<string, unknown>,
  error?: {
    code?: unknown;
    message?: unknown;
  },
];
export function createRuntimeStub(callId = "call-1"): VoiceCallRuntime {
  const call = createCallRecord({ callId });
  return {
    config: {
      toNumber: "+15550001234",
      realtime: { enabled: false },
    } as VoiceCallRuntime["config"],
    provider: {} as VoiceCallRuntime["provider"],
    manager: {
      initiateCall: vi.fn(async () => ({ callId, success: true })),
      continueCall: vi.fn(async () => ({
        success: true,
        transcript: "hello",
      })),
      speak: vi.fn(async () => ({ success: true })),
      sendDtmf: vi.fn(async () => ({ success: true })),
      endCall: vi.fn(async () => ({ success: true })),
      getCall: vi.fn((id: string) => (id === callId ? call : undefined)),
      getCallByProviderCallId: vi.fn(() => undefined),
      getCallFromMemoryOrStore: vi.fn(async (id: string) => (id === callId ? call : undefined)),
      getActiveCalls: vi.fn(() => [call]),
      getCallHistory: vi.fn(async () => []),
    } as unknown as VoiceCallRuntime["manager"],
    webhookServer: {
      speakRealtime: vi.fn(() => ({ success: false, error: "No active realtime bridge for call" })),
    } as unknown as VoiceCallRuntime["webhookServer"],
    webhookUrl: "http://127.0.0.1:3334/voice/webhook",
    publicUrl: null,
    stop: vi.fn(async () => {}),
  };
}

export function createCallRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: "call-1",
    provider: "mock",
    direction: "outbound",
    state: "active",
    from: "+15550001111",
    to: "+15550001234",
    startedAt: Date.UTC(2026, 4, 2, 9, 0, 0),
    transcript: [],
    processedEventIds: [],
    ...overrides,
  };
}

export function createPrivateCallRecord(): CallRecord {
  return createCallRecord({
    metadata: { requesterSessionKey: "agent:main:discord:channel:general" },
    processedEventIds: ["evt-1"],
    sessionKey: "agent:main:voice:call-1",
    transcript: [
      {
        timestamp: Date.UTC(2026, 4, 2, 9, 1, 0),
        speaker: "user",
        text: "private call transcript",
        isFinal: true,
      },
    ],
  });
}

export function setup(
  config: Record<string, unknown>,
  toolContext: Record<string, unknown> = {},
): Registered {
  const methods = new Map<string, unknown>();
  const methodScopes = new Map<string, string | undefined>();
  const tools: unknown[] = [];
  let service: Registered["service"];
  const api = createTestPluginApi({
    id: "voice-call",
    name: "Voice Call",
    description: "test",
    version: "0",
    source: "test",
    registrationMode: "full",
    config: {},
    pluginConfig: config,
    runtime: { tts: { textToSpeechTelephony: vi.fn() } } as unknown as OpenClawPluginApi["runtime"],
    logger: noopLogger,
    registerGatewayMethod: (method: string, handler: unknown, opts?: { scope?: string }) => {
      methods.set(method, handler);
      methodScopes.set(method, opts?.scope);
    },
    registerTool: (tool: unknown) =>
      tools.push(
        typeof tool === "function"
          ? (tool as (context: Record<string, unknown>) => unknown)(toolContext)
          : tool,
      ),
    registerCli: () => {},
    registerService: (registeredService) => {
      service = registeredService;
    },
    resolvePath: (p: string) => p,
  });
  plugin.register(api);
  return { methods, methodScopes, tools, service };
}

export function mockCall(source: MockCallSource, callIndex = 0): ReadonlyArray<unknown> {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call ${callIndex}`);
  }
  return call;
}

export function firstRespondCall(source: MockCallSource): RespondCall {
  return mockCall(source) as unknown as RespondCall;
}

export function expectRedactedVoiceCallStatus(value: unknown): void {
  expect(value).toEqual({
    callId: "call-1",
    provider: "mock",
    direction: "outbound",
    state: "active",
    startedAt: Date.UTC(2026, 4, 2, 9, 0, 0),
  });
  expect(value).not.toHaveProperty("from");
  expect(value).not.toHaveProperty("to");
  expect(value).not.toHaveProperty("sessionKey");
  expect(value).not.toHaveProperty("transcript");
  expect(value).not.toHaveProperty("processedEventIds");
  expect(value).not.toHaveProperty("metadata");
}
