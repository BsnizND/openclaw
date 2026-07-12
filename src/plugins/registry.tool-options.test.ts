// Verifies plugin tool execution-budget registration at the registry boundary.
import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";

function createTestRegistry() {
  return createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
}

function createTool(): AnyAgentTool {
  return {
    name: "long_workflow",
    description: "Run a long workflow",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  } as unknown as AnyAgentTool;
}

function createToolOwnerRecord() {
  return createPluginRecord({
    id: "workflow-plugin",
    name: "Workflow Plugin",
    source: "/plugins/workflow-plugin/index.js",
    origin: "global",
    enabled: true,
    configSchema: false,
    contracts: { tools: ["long_workflow"] },
  });
}

describe("plugin tool registration options", () => {
  it("stores a positive execution timeout on the tool registration", () => {
    const pluginRegistry = createTestRegistry();
    const record = createToolOwnerRecord();
    const api = pluginRegistry.createApi(record, { config: {} as OpenClawConfig });

    api.registerTool(createTool(), { optional: true, timeoutMs: 240_000 });

    expect(pluginRegistry.registry.tools).toHaveLength(1);
    expect(pluginRegistry.registry.tools[0]).toMatchObject({
      pluginId: "workflow-plugin",
      optional: true,
      timeoutMs: 240_000,
    });
  });

  it("rejects invalid execution timeouts", () => {
    const pluginRegistry = createTestRegistry();
    const record = createToolOwnerRecord();
    const api = pluginRegistry.createApi(record, { config: {} as OpenClawConfig });

    api.registerTool(createTool(), { timeoutMs: 0 });

    expect(pluginRegistry.registry.tools).toHaveLength(0);
    expect(pluginRegistry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "workflow-plugin",
        message: "plugin tool timeoutMs must be a positive safe integer",
      }),
    );
  });
});
