import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePluginNpmGenerationProjectDir } from "./install-paths.js";
import {
  cleanupRetainedManagedNpmInstallGenerations,
  hasRetainedManagedNpmInstallMarker,
  markRetainedManagedNpmInstall,
} from "./managed-npm-retention.js";

describe("managed npm retention", () => {
  it("cleans retired generations while preserving the active install root", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-retention-"));
    const npmDir = path.join(stateDir, "npm");
    const packageName = "@openclaw/codex";
    const oldProjectRoot = resolvePluginNpmGenerationProjectDir({
      npmDir,
      packageName,
      generationKey: "codex-v1",
    });
    const activeProjectRoot = resolvePluginNpmGenerationProjectDir({
      npmDir,
      packageName,
      generationKey: "codex-v2",
    });
    const oldPackageDir = path.join(oldProjectRoot, "node_modules", "@openclaw", "codex");
    const activePackageDir = path.join(activeProjectRoot, "node_modules", "@openclaw", "codex");
    fs.mkdirSync(oldPackageDir, { recursive: true });
    fs.mkdirSync(activePackageDir, { recursive: true });
    await markRetainedManagedNpmInstall({
      packageDir: oldPackageDir,
      pluginId: "codex",
      reason: "test-retired-generation",
    });

    try {
      await expect(
        cleanupRetainedManagedNpmInstallGenerations({
          npmDir,
          activeInstallPaths: [activePackageDir],
        }),
      ).resolves.toBe(1);
      expect(fs.existsSync(oldProjectRoot)).toBe(false);
      expect(fs.existsSync(activeProjectRoot)).toBe(true);
      expect(hasRetainedManagedNpmInstallMarker(activePackageDir)).toBe(false);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("cleans retained packages from the legacy shared npm root", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-retention-"));
    const npmDir = path.join(stateDir, "npm");
    const packageDir = path.join(npmDir, "node_modules", "@openclaw", "codex");
    fs.mkdirSync(packageDir, { recursive: true });
    await markRetainedManagedNpmInstall({
      packageDir,
      pluginId: "codex",
      reason: "test-legacy-generation",
    });

    try {
      await expect(
        cleanupRetainedManagedNpmInstallGenerations({
          npmDir,
        }),
      ).resolves.toBe(1);
      expect(fs.existsSync(packageDir)).toBe(false);
      expect(hasRetainedManagedNpmInstallMarker(packageDir)).toBe(false);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("cleans only stale incomplete managed generation projects", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-retention-"));
    const npmDir = path.join(stateDir, "npm");
    const staleProjectRoot = resolvePluginNpmGenerationProjectDir({
      npmDir,
      packageName: "@openclaw/acpx",
      generationKey: "stale-incomplete",
    });
    const activeProjectRoot = resolvePluginNpmGenerationProjectDir({
      npmDir,
      packageName: "@openclaw/acpx",
      generationKey: "active-incomplete",
    });
    const recentProjectRoot = resolvePluginNpmGenerationProjectDir({
      npmDir,
      packageName: "@openclaw/acpx",
      generationKey: "recent-incomplete",
    });
    const activePackageDir = path.join(activeProjectRoot, "node_modules", "@openclaw", "acpx");
    fs.mkdirSync(path.join(staleProjectRoot, "node_modules"), { recursive: true });
    fs.mkdirSync(activePackageDir, { recursive: true });
    fs.mkdirSync(path.join(recentProjectRoot, "node_modules"), { recursive: true });
    const nowMs = Date.now();
    const staleDate = new Date(nowMs - 48 * 60 * 60 * 1000);
    fs.utimesSync(staleProjectRoot, staleDate, staleDate);
    fs.utimesSync(activeProjectRoot, staleDate, staleDate);

    try {
      await expect(
        cleanupRetainedManagedNpmInstallGenerations({
          npmDir,
          activeInstallPaths: [activePackageDir],
          nowMs,
        }),
      ).resolves.toBe(1);
      expect(fs.existsSync(staleProjectRoot)).toBe(false);
      expect(fs.existsSync(activeProjectRoot)).toBe(true);
      expect(fs.existsSync(recentProjectRoot)).toBe(true);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
