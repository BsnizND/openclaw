/** Shared generation and loader state for plugin Doctor contracts. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { PluginModuleLoaderFactory } from "./plugin-module-loader-cache.js";

export const pluginDoctorContractRegistryLoaderState = {
  moduleLoaderFactory: undefined as PluginModuleLoaderFactory | undefined,
};

const deferredPluginMigrations = new AsyncLocalStorage<ReadonlySet<string>>();

/** A prepared Doctor generation excludes unavailable owners from every migration surface. */
export function withDeferredPluginDoctorMigrations<T>(
  pluginIds: readonly string[],
  run: () => T,
): T {
  return deferredPluginMigrations.run(new Set(pluginIds), run);
}

export function isPluginDoctorMigrationDeferred(pluginId: string): boolean {
  return deferredPluginMigrations.getStore()?.has(pluginId) === true;
}
