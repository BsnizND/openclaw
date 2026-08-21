// Memory Wiki tests cover tool plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { lintMemoryWikiVault } from "./lint.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { createWikiApplyTool, createWikiGetTool, createWikiLintTool } from "./tool.js";

function asSchemaObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected JSON schema object");
  }
  return value as Record<string, unknown>;
}

function unionLiteralValues(schema: Record<string, unknown>): string[] {
  const variants = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(variants)) {
    throw new Error("Expected union schema variants");
  }
  return variants
    .map((variant) => asSchemaObject(variant).const)
    .filter((value): value is string => typeof value === "string")
    .toSorted();
}

describe("memory-wiki tools", () => {
  const harness = createMemoryWikiTestHarness();

  it("accepts CLI-style operation aliases in wiki_apply schema", () => {
    const tool = createWikiApplyTool({} as ResolvedMemoryWikiConfig);
    const applyProperties = asSchemaObject(asSchemaObject(tool.parameters).properties);
    const opSchema = asSchemaObject(applyProperties.op);

    expect(unionLiteralValues(opSchema)).toEqual([
      "create_synthesis",
      "metadata",
      "synthesis",
      "update_metadata",
    ]);
  });

  it("allows provenance metadata in wiki_apply claim evidence", () => {
    const tool = createWikiApplyTool({} as ResolvedMemoryWikiConfig);
    const applyProperties = asSchemaObject(asSchemaObject(tool.parameters).properties);
    const claimsSchema = asSchemaObject(applyProperties.claims);
    const claimSchema = asSchemaObject(claimsSchema.items);
    const claimProperties = asSchemaObject(claimSchema.properties);
    const evidenceSchema = asSchemaObject(claimProperties.evidence);
    const evidenceArraySchema = asSchemaObject(evidenceSchema.items);
    const evidenceProperties = asSchemaObject(evidenceArraySchema.properties);

    expect(Object.keys(evidenceProperties).toSorted()).toEqual([
      "confidence",
      "kind",
      "lines",
      "note",
      "path",
      "privacyTier",
      "sourceId",
      "updatedAt",
      "weight",
    ]);
    expect(evidenceProperties.confidence).toEqual({ type: "number", minimum: 0, maximum: 1 });
  });

  it("rejects non-object wiki_apply arguments without throwing a TypeError", async () => {
    const { config } = await harness.createVault({ initialize: true });
    const tool = createWikiApplyTool(config);

    await expect(tool.execute("malformed-null", null)).rejects.toThrow(
      "wiki mutation requires lookup for update_metadata.",
    );
    await expect(tool.execute("malformed-undefined", undefined)).rejects.toThrow(
      "wiki mutation requires lookup for update_metadata.",
    );
  });

  it("returns tool-safe relative report paths from wiki_lint", async () => {
    const { rootDir, config } = await harness.createVault({ initialize: true });
    await fs.mkdir(path.join(rootDir, "syntheses"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "syntheses", "bad.md"),
      [
        "---",
        "id: synth-bad",
        "pageType: synthesis",
        "title: Bad Page",
        "---",
        "",
        "This links to [[Missing Page]].",
      ].join("\n"),
      "utf8",
    );

    const tool = createWikiLintTool(config);
    const result = await tool.execute("lint-call", {});
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    const details = asSchemaObject(result.details);

    expect(text).toContain("Report: reports/lint.md");
    expect(text).not.toContain(rootDir);
    expect(details.reportPath).toBe("reports/lint.md");
    expect(details).not.toHaveProperty("vaultRoot");
    expect(JSON.stringify(details)).not.toContain(rootDir);
    expect(asSchemaObject(details.issuesByCategory).links).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "broken-wikilink" })]),
    );

    const lintResult = await lintMemoryWikiVault(config);
    expect(path.isAbsolute(lintResult.reportPath)).toBe(true);
    expect(lintResult.reportPath).toContain(rootDir);
  });

  it("reads an exact isolated wiki page without waiting for the mutation owner", async () => {
    const { rootDir, config } = await harness.createVault({ initialize: true });
    const pagePath = path.join(rootDir, "syntheses", "alpha.md");
    await fs.mkdir(path.dirname(pagePath), { recursive: true });
    await fs.writeFile(
      pagePath,
      [
        "---",
        "id: synthesis.alpha",
        "pageType: synthesis",
        "title: Alpha",
        "---",
        "",
        "Exact useful content.",
      ].join("\n"),
      "utf8",
    );

    let releaseMutation!: () => void;
    let mutationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      mutationStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const holder = withMemoryWikiVaultMutation(config.vault.path, async () => {
      mutationStarted();
      await release;
    });
    await started;

    try {
      const result = await Promise.race([
        createWikiGetTool(config).execute("get-isolated", { lookup: "syntheses/alpha.md" }),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("isolated wiki_get waited for mutation owner")), 1_000);
        }),
      ]);
      expect(result.details).toEqual(expect.objectContaining({ found: true }));
    } finally {
      releaseMutation();
      await holder;
    }
  });
});
