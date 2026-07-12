// Verifies registered plugin timeouts survive cached resolution and Codex tool projection.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import type { AnyAgentTool } from "../src/plugin-sdk/agent-harness-runtime.js";
import { createOpenClawCodingTools } from "../src/plugin-sdk/agent-harness.js";
import { clearPluginLoaderCache, loadOpenClawPlugins } from "../src/plugins/loader.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";
import { resetPluginToolDescriptorCache } from "../src/plugins/tools.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../src/test-utils/bundled-plugin-public-surface.js";

type CodexTimeoutTestApi = {
  resolveCodexDynamicToolTimeoutForTest(params: {
    tools: AnyAgentTool[];
    toolName: string;
  }): number;
};

const PLUGIN_ID = "timeout-fixture";
const TOOL_NAME = "timeout_fixture_read";
const FACTORY_COUNT_KEY = "__openclawTimeoutFixtureFactoryCount";
const EMPTY_PLUGIN_SCHEMA = { type: "object", additionalProperties: false, properties: {} };
const previousDisableBundledPlugins = process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
const tempDirs: string[] = [];
const CODEX_TEST_API_MODULE_ID = resolveRelativeBundledPluginPublicModuleId({
  fromModuleUrl: import.meta.url,
  pluginId: "codex",
  artifactBasename: "test-api.js",
});

function requireTool(tools: AnyAgentTool[]): AnyAgentTool {
  const tool = tools.find((candidate) => candidate.name === TOOL_NAME);
  if (!tool) {
    throw new Error(`expected ${TOOL_NAME} tool`);
  }
  return tool;
}

async function loadCodexTimeoutTestApi(): Promise<CodexTimeoutTestApi> {
  return (await import(CODEX_TEST_API_MODULE_ID)) as CodexTimeoutTestApi;
}

function createFixturePlugin() {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-tool-timeout-")),
  );
  tempDirs.push(dir);
  const file = path.join(dir, "index.cjs");
  fs.writeFileSync(
    file,
    `module.exports = {
  id: ${JSON.stringify(PLUGIN_ID)},
  register(api) {
    api.registerTool(() => {
      globalThis.${FACTORY_COUNT_KEY} = (globalThis.${FACTORY_COUNT_KEY} || 0) + 1;
      return {
        name: ${JSON.stringify(TOOL_NAME)},
        description: "Read source-backed context",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
      };
    }, { names: [${JSON.stringify(TOOL_NAME)}], optional: true, timeoutMs: 600000 });
  },
};`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: PLUGIN_ID,
        configSchema: EMPTY_PLUGIN_SCHEMA,
        contracts: { tools: [TOOL_NAME] },
        toolMetadata: { [TOOL_NAME]: { optional: true } },
      },
      null,
      2,
    ),
    "utf8",
  );
  return { dir, file };
}

describe("Codex plugin tool timeout integration", () => {
  afterEach(() => {
    resetPluginToolDescriptorCache();
    clearPluginLoaderCache();
    resetPluginRuntimeStateForTest();
    delete (globalThis as Record<string, unknown>)[FACTORY_COUNT_KEY];
    if (previousDisableBundledPlugins === undefined) {
      delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
    } else {
      process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = previousDisableBundledPlugins;
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves a registered timeout through cached agent tools and the Codex bridge", async () => {
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    const plugin = createFixturePlugin();
    const config: OpenClawConfig = {
      plugins: {
        allow: [PLUGIN_ID],
        load: { paths: [plugin.file] },
        entries: { [PLUGIN_ID]: { enabled: true } },
      },
      tools: { allow: [TOOL_NAME] },
    };
    const registry = loadOpenClawPlugins({
      activate: false,
      cache: false,
      config,
      workspaceDir: plugin.dir,
    });
    setActivePluginRegistry(registry, "timeout-fixture", "gateway-bindable", plugin.dir);

    const firstTools = createOpenClawCodingTools({
      agentId: "main",
      config,
      modelId: "gpt-5.5",
      modelProvider: "openai",
      workspaceDir: plugin.dir,
    });
    const cachedTools = createOpenClawCodingTools({
      agentId: "main",
      config,
      modelId: "gpt-5.5",
      modelProvider: "openai",
      workspaceDir: plugin.dir,
    });
    const firstTool = requireTool(firstTools);
    const cachedTool = requireTool(cachedTools);
    const codexApi = await loadCodexTimeoutTestApi();

    expect((globalThis as Record<string, unknown>)[FACTORY_COUNT_KEY]).toBe(1);
    expect(
      codexApi.resolveCodexDynamicToolTimeoutForTest({
        tools: [firstTool],
        toolName: TOOL_NAME,
      }),
    ).toBe(600_000);
    expect(
      codexApi.resolveCodexDynamicToolTimeoutForTest({
        tools: [cachedTool],
        toolName: TOOL_NAME,
      }),
    ).toBe(600_000);
  });
});
