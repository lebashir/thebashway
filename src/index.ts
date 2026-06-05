// src/index.ts — the package's public surface.
export * from "./binding";
export * from "./sinks";
export * from "./router";
export { runInit, detectProject, initMessage } from "./init";
export { checkSync, readSyncRef } from "./check-sync";
export { setBinding, resetBinding, getDefaultSurface } from "./engine/config";
export { drain, defaultDrainDeps } from "./engine/drain";
export { runAudit, defaultAuditDeps } from "./engine/audit-run";
export { runFeatureDesign, defaultDesignDeps } from "./engine/design-run";
export { runClaude } from "./engine/headless";
