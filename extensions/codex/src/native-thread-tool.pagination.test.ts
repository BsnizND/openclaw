import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { estimateToolResultTextChars } from "openclaw/plugin-sdk/text-utility-runtime";
import { describe, expect, it, vi } from "vitest";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import { createCodexDynamicToolBridge } from "./app-server/dynamic-tools.js";
import { createCodexTestBindingStore } from "./app-server/session-binding.test-helpers.js";
import { createCodexThreadsTool } from "./native-thread-tool.js";

function createTool(params: {
  request: ReturnType<typeof vi.fn>;
  omitHomeScope?: boolean;
  supervision?: boolean;
  allowRawTranscripts?: boolean;
}) {
  return createCodexThreadsTool({
    bindingStore: createCodexTestBindingStore(),
    context: { config: {}, agentId: "main", senderIsOwner: true },
    runtime: createPluginRuntimeMock(),
    getPluginConfig: () => ({
      ...(params.omitHomeScope ? {} : { appServer: { homeScope: "user" } }),
      ...(params.supervision
        ? {
            supervision: {
              enabled: true,
              allowRawTranscripts: params.allowRawTranscripts === true,
            },
          }
        : {}),
    }),
    request: params.request as never,
  });
}

describe("bounded native reads", () => {
  function entry(id: string, text = id) {
    return { turnId: "turn-1", item: { id, type: "agentMessage", text } };
  }

  // The native store is an external boundary. Its cursor identifies the last delivered
  // item, so changing the requested count or appending newer items cannot shift it.
  function itemReader(source: ReturnType<typeof entry>[]) {
    return vi.fn(async (_config, method: string, raw: unknown) => {
      const params = raw as { cursor?: string; limit: number };
      if (method === CODEX_CONTROL_METHODS.readThread) {
        return { thread: { id: "thread-1", turns: [{ id: "turn-1", items: source }] } };
      }
      if (method !== CODEX_CONTROL_METHODS.listThreadItems) {
        throw new Error("unexpected native method");
      }
      const anchor = params.cursor
        ? source.findIndex(({ item }) => `native:${item.id}` === params.cursor)
        : -1;
      if (params.cursor && anchor < 0) {
        throw new Error("invalid native cursor");
      }
      const data = source.slice(anchor + 1, anchor + 1 + params.limit);
      return {
        data,
        nextCursor:
          anchor + 1 + data.length < source.length ? `native:${data.at(-1)?.item.id}` : null,
      };
    });
  }

  it("preserves complete items, turn identity and the exact continuation cursor", async () => {
    const tool = createTool({ request: itemReader([entry("c"), entry("b"), entry("a")]) });
    const result = await tool?.execute("read-page", {
      action: "read",
      thread_id: "thread-1",
      include_turns: true,
      item_limit: 2,
    });
    expect(result?.details).toEqual({
      threadId: "thread-1",
      items: [entry("c"), entry("b")],
      nextCursor: "native:b",
      order: "newest_first",
    });
    const next = await tool?.execute("read-next", {
      action: "read",
      thread_id: "thread-1",
      include_turns: true,
      cursor: "native:b",
    });
    expect(next?.details).toEqual({
      threadId: "thread-1",
      items: [entry("a")],
      nextCursor: null,
      order: "newest_first",
    });
  });

  it.each([
    { label: "ASCII", text: "x".repeat(6_000), contextWindowTokens: 32_000 },
    {
      label: "CJK and supplementary Unicode",
      text: "界🌱".repeat(1_100),
      contextWindowTokens: 128_000,
    },
    { label: "escaped JSON", text: '\n"\\'.repeat(1_500), contextWindowTokens: 256_000 },
  ])(
    "delivers complete $label pages through the real dynamic bridge",
    async ({ text, contextWindowTokens }) => {
      const source = [
        entry("e", text),
        entry("d", text),
        entry("c", text),
        entry("b", text),
        entry("a", text),
      ];
      const before = structuredClone(source);
      const request = itemReader(source);
      const tool = createTool({ request });
      if (!tool) {
        throw new Error("owner tool missing");
      }
      const bridge = createCodexDynamicToolBridge({
        tools: [tool],
        signal: new AbortController().signal,
        hookContext: { contextWindowTokens },
      });
      const delivered: ReturnType<typeof entry>[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const response = await bridge.handleToolCall({
          threadId: "caller",
          turnId: "caller-turn",
          callId: `page-${pages}`,
          namespace: null,
          tool: "codex_threads",
          arguments: {
            action: "read",
            thread_id: "thread-1",
            include_turns: true,
            item_limit: 50,
            ...(cursor ? { cursor } : {}),
          },
        });
        expect(response.success).toBe(true);
        const block = response.contentItems[0];
        if (block?.type !== "inputText" || typeof block.text !== "string") {
          throw new Error("missing model text");
        }
        expect(block.text).not.toContain("OpenClaw truncated dynamic tool result");
        expect(estimateToolResultTextChars(block.text)).toBeLessThanOrEqual(16_000);
        expect(Buffer.byteLength(block.text, "utf8")).toBeLessThanOrEqual(64_000);
        const page = JSON.parse(block.text);
        delivered.push(...page.items);
        cursor = page.nextCursor;
        expect(++pages).toBeLessThanOrEqual(5);
      } while (cursor);
      expect(pages).toBeGreaterThan(1);
      expect(delivered.map(({ item }) => item.id)).toEqual(["e", "d", "c", "b", "a"]);
      expect(delivered.every(({ item }) => item.text === text)).toBe(true);
      expect(source).toEqual(before);
    },
  );

  it("continues from the delivered item after newer history is appended", async () => {
    const source = [entry("c"), entry("b"), entry("a")];
    const tool = createTool({ request: itemReader(source) });
    const first = await tool?.execute("first", {
      action: "read",
      thread_id: "thread-1",
      include_turns: true,
      item_limit: 1,
    });
    expect(first?.details).toMatchObject({ nextCursor: "native:c" });
    source.unshift(entry("new"));
    const second = await tool?.execute("second", {
      action: "read",
      thread_id: "thread-1",
      include_turns: true,
      item_limit: 2,
      cursor: "native:c",
    });
    expect(second?.details).toMatchObject({
      items: [entry("b"), entry("a")],
      nextCursor: null,
    });
  });

  it("reports a single oversized item as failure without exposing a partial page", async () => {
    const tool = createTool({
      request: itemReader([entry("huge", "z".repeat(70_000)), entry("older")]),
    });
    if (!tool) {
      throw new Error("owner tool missing");
    }
    const bridge = createCodexDynamicToolBridge({
      tools: [tool],
      signal: new AbortController().signal,
    });
    const result = await bridge.handleToolCall({
      threadId: "caller",
      turnId: "turn",
      callId: "oversized",
      namespace: null,
      tool: "codex_threads",
      arguments: { action: "read", thread_id: "thread-1", include_turns: true, item_limit: 50 },
    });
    expect(result.success).toBe(false);
    const block = result.contentItems[0];
    if (block?.type !== "inputText" || typeof block.text !== "string") {
      throw new Error("missing error text");
    }
    expect(block.text).toContain("exceeds");
    expect(block.text).toContain("No items");
    expect(block.text.length).toBeLessThan(500);
    expect(block.text).not.toContain("nextCursor");
    expect(block.text).not.toContain("zzzz");
  });

  it("includes continuation metadata in the size check", async () => {
    const request = vi.fn(async () => ({ data: [entry("a")], nextCursor: "c".repeat(20_000) }));
    const tool = createTool({ request });
    await expect(
      tool?.execute("large-cursor", {
        action: "read",
        thread_id: "thread-1",
        include_turns: true,
        item_limit: 1,
      }),
    ).rejects.toThrow("exceeds");
  });

  it("bounds native failures that echo an invalid cursor", async () => {
    const cursor = "invalid-" + "界".repeat(20_000);
    const request = vi.fn(async () => {
      throw new Error(`invalid cursor: ${cursor}`);
    });
    const tool = createTool({ request });
    if (!tool) {
      throw new Error("owner tool missing");
    }
    const bridge = createCodexDynamicToolBridge({
      tools: [tool],
      signal: new AbortController().signal,
    });
    const result = await bridge.handleToolCall({
      threadId: "caller",
      turnId: "turn",
      callId: "bad-cursor",
      namespace: null,
      tool: "codex_threads",
      arguments: { action: "read", thread_id: "thread-1", include_turns: true, cursor },
    });
    expect(result.success).toBe(false);
    const block = result.contentItems[0];
    if (block?.type !== "inputText" || typeof block.text !== "string") {
      throw new Error("missing error text");
    }
    expect(estimateToolResultTextChars(block.text)).toBeLessThan(500);
    expect(block.text).not.toContain(cursor);
  });

  it.each([
    { data: "not an array", nextCursor: null },
    { data: [entry("a")], nextCursor: { invalid: true } },
    { data: [entry("a")], nextCursor: "" },
    { data: [{ turnId: "turn-1", item: { text: "missing native identity" } }], nextCursor: null },
  ])("rejects an invalid native page rather than declaring history complete", async (page) => {
    const tool = createTool({ request: vi.fn(async () => page) });
    await expect(
      tool?.execute("invalid-page", {
        action: "read",
        thread_id: "thread-1",
        include_turns: true,
        item_limit: 1,
      }),
    ).rejects.toThrow("invalid native item page");
  });

  it.each([
    { include_turns: false, item_limit: 1 },
    { include_turns: true, item_limit: 0 },
    { include_turns: true, item_limit: 51 },
    { include_turns: true, item_limit: 1.5 },
    { include_turns: true, cursor: " " },
  ])("rejects invalid paging arguments without performing a full read", async (params) => {
    const request = itemReader([entry("a")]);
    const tool = createTool({ request });
    await expect(
      tool?.execute("invalid-args", {
        action: "read",
        thread_id: "thread-1",
        ...params,
      }),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps raw-transcript permission and supervision connection selection for pages", async () => {
    const request = itemReader([entry("a")]);
    const denied = createTool({ omitHomeScope: true, supervision: true, request });
    const params = {
      action: "read",
      thread_id: "thread-1",
      include_turns: true,
      item_limit: 1,
    };
    await expect(denied?.execute("denied", params)).rejects.toThrow(
      "raw transcript reads are disabled",
    );
    expect(request).not.toHaveBeenCalled();
    const allowed = createTool({
      omitHomeScope: true,
      supervision: true,
      allowRawTranscripts: true,
      request,
    });
    const result = await allowed?.execute("allowed", params);
    expect(result?.details).toMatchObject({ items: [entry("a")] });
    expect(request).toHaveBeenCalledWith(
      expect.anything(),
      CODEX_CONTROL_METHODS.listThreadItems,
      { threadId: "thread-1", limit: 1, sortDirection: "desc" },
      expect.objectContaining({
        authProfileId: null,
        startOptions: expect.objectContaining({ homeScope: "user" }),
      }),
    );
  });
});
