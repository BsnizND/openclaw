import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  registerPluginSubagentRunFromGateway,
  resolveGatewayAgentTaskTrackingMode,
} from "./agent-task-tracking.js";

const mocks = vi.hoisted(() => ({
  registerSubagentRun: vi.fn(),
}));

vi.mock("../../agents/subagent-registry.js", () => ({
  registerSubagentRun: mocks.registerSubagentRun,
}));

const cfg = {
  agents: {
    list: [{ id: "jay" }],
  },
} satisfies OpenClawConfig;

describe("plugin subagent task tracking", () => {
  beforeEach(() => {
    mocks.registerSubagentRun.mockReset();
  });

  it("keeps internal-system plugin subagents tracked", () => {
    expect(
      resolveGatewayAgentTaskTrackingMode({
        client: {
          internal: { agentRunTracking: "plugin_subagent" },
        } as never,
        sessionKey: "agent:jay:dashboard:incognito-doordash-child",
        inputProvenance: {
          kind: "internal_system",
          sourceSessionKey: "agent:jay:lifeos-home:requester",
          sourceTool: "plugin_subagent",
        },
      }),
    ).toBe("plugin_subagent");
  });

  it("registers the native controller and exact canonical requester", async () => {
    await registerPluginSubagentRunFromGateway({
      cfg,
      runId: "run-doordash",
      childSessionKey: "agent:jay:dashboard:incognito-doordash-child",
      requesterSessionKey: "  agent:jay:lifeos-home:requester  ",
      task: "complete the bounded DoorDash transaction",
      pluginId: "doordash-ordering-tools",
    });

    expect(mocks.registerSubagentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-doordash",
        childSessionKey: "agent:jay:dashboard:incognito-doordash-child",
        controllerSessionKey: "agent:jay:main",
        requesterSessionKey: "agent:jay:lifeos-home:requester",
        label: "plugin:doordash-ordering-tools",
        spawnMode: "run",
      }),
    );
  });
});
