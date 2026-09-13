import { describe, expect, it } from "vitest";
import { readCodexPluginConfig } from "./config-parsing.js";

describe("Codex native queue config", () => {
  it("accepts an explicit default-off queue grant and absolute local Unix endpoint", () => {
    expect(
      readCodexPluginConfig({
        supervision: {
          enabled: true,
          allowQueueControls: true,
          queueEndpoint: "unix:///tmp/codex-app-server-control.sock",
        },
      }).supervision,
    ).toEqual({
      enabled: true,
      allowQueueControls: true,
      queueEndpoint: "unix:///tmp/codex-app-server-control.sock",
    });
    expect(readCodexPluginConfig({ supervision: { enabled: true } }).supervision).toEqual({
      enabled: true,
    });
  });

  it.each([
    "unix://relative.sock",
    "unix://remote-host/tmp/control.sock",
    "unix:///",
    "unix:///tmp/control.sock?token=secret",
    "ws://127.0.0.1/control.sock",
    "/tmp/control.sock",
  ])("rejects non-local or non-absolute queue endpoint %s", (queueEndpoint) => {
    expect(readCodexPluginConfig({ supervision: { enabled: true, queueEndpoint } })).toStrictEqual(
      {},
    );
  });
});
