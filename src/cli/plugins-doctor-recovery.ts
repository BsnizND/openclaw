/** Explicit offline actions remain with the selected trusted plugin Doctor owner. */
import { withDoctorSqliteMaintenanceLock } from "../commands/doctor-sqlite-maintenance-lock.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { runPostSessionPluginDoctorStateRepairs } from "../infra/state-migrations.plugin-doctor.js";
import { loadBundledPluginManifestRegistry } from "../plugins/manifest-registry-build.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { loadPluginManifestRegistryForPluginRegistry } from "../plugins/plugin-registry.js";
import { defaultRuntime } from "../runtime.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db.js";
import { exitCliAfterOutput } from "./one-shot-exit.js";
import type { PluginDoctorOptions } from "./plugins-cli.js";

async function runPluginDoctorRecovery(opts: PluginDoctorOptions, env = process.env) {
  if (
    !opts.plugin?.trim() ||
    !opts.migration?.trim() ||
    !opts.recovery?.trim() ||
    !opts.ids?.length ||
    !opts.reason?.trim() ||
    opts.confirmRetiredWithoutDelivery !== true ||
    !["installed", "bundled"].includes(opts.source ?? "installed")
  ) {
    throw new Error(
      "Offline recovery requires exact --plugin, --migration, --recovery, --ids, --reason and --confirm-retired-without-delivery; --source is installed or bundled",
    );
  }
  return await withDoctorSqliteMaintenanceLock({
    env,
    operation: "explicit plugin Doctor recovery",
    run: async (maintenance) =>
      withAgentDatabaseMaintenanceLease(
        { env, schemaPolicy: "existing", processBound: true },
        async () =>
          withPluginLifecycleLease(
            { env, schemaPolicy: "existing", assertCurrent: () => maintenance.assertCurrent() },
            async (lease) => {
              const snapshot = await readConfigFileSnapshot();
              maintenance.assertCurrent();
              lease.assertOwned();
              if (!snapshot.valid) {
                throw new Error("Repair invalid configuration before plugin recovery");
              }
              const config = snapshot.runtimeConfig;
              const registry =
                opts.source === "bundled"
                  ? loadBundledPluginManifestRegistry({
                      env: { ...env, OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1" },
                    })
                  : loadPluginManifestRegistryForPluginRegistry({
                      config,
                      env,
                      includeDisabled: true,
                    });
              const records = registry.plugins.filter((record) => record.id === opts.plugin);
              const record = records[0];
              if (
                records.length !== 1 ||
                !record ||
                (record.origin !== "bundled" && record.trustedOfficialInstall !== true)
              ) {
                throw new Error(
                  "Offline recovery requires exactly one trusted installed or packaged bundled plugin owner",
                );
              }
              const inventory = {
                records,
                knownPluginIds: [record.id],
                sessionStoreOwnerPluginIds: [],
                descriptors: [],
                unresolvedPluginIds: [],
              };
              const result = await runPostSessionPluginDoctorStateRepairs({
                config,
                env,
                maintenanceAuthority: maintenance,
                inventory,
                recovery: {
                  pluginId: record.id,
                  migrationId: opts.migration!,
                  request: { action: opts.recovery!, ids: opts.ids!, reason: opts.reason! },
                },
              });
              maintenance.assertCurrent();
              lease.assertOwned();
              return { ...result, stateDir: resolveStateDir(env) };
            },
          ),
      ),
  });
}

export async function runPluginsDoctorCommand(opts: PluginDoctorOptions = {}): Promise<void> {
  if (
    opts.source ||
    opts.recovery ||
    opts.plugin ||
    opts.migration ||
    opts.ids ||
    opts.reason ||
    opts.confirmRetiredWithoutDelivery
  ) {
    const result = await runPluginDoctorRecovery(opts);
    defaultRuntime.log(
      opts.json
        ? JSON.stringify(result, null, 2)
        : [...result.changes, ...(result.notices ?? []), ...result.warnings].join("\n"),
    );
    return exitCliAfterOutput(defaultRuntime, result.warnings.length ? 1 : 0);
  }
  const inspection = await import("./plugins-cli.runtime.js");
  return await inspection.runPluginsDoctorCommand(opts);
}
