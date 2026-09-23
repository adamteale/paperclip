import type { IssueLivenessFinding } from "./issue-graph-liveness.js";

// Compatibility shim: upstream v2026.916.0 removed cheap model profiles
// (migration 0236). Our liveness escalation keeps its status-only recovery
// guard semantics, minus the model-profile wiring.
export const STATUS_ONLY_RECOVERY_GUARD_CONTEXT = {
  recoveryIntent: "status_only",
  allowDeliverableWork: false,
  allowDocumentUpdates: false,
  resumeRequiresNormalModel: true,
} as const;

export function withRecoveryModelProfileHint<T extends Record<string, unknown>>(
  input: T,
  _workClass: "status_only" | "normal_model",
): T & typeof STATUS_ONLY_RECOVERY_GUARD_CONTEXT {
  return { ...input, ...STATUS_ONLY_RECOVERY_GUARD_CONTEXT };
}

export function recoveryAssigneeAdapterOverrides(
  _workClass: "status_only" | "normal_model",
): Record<string, never> {
  return {};
}

export function formatDependencyPath(finding: IssueLivenessFinding) {
  return finding.dependencyPath
    .map((entry) => entry.identifier ?? entry.issueId)
    .join(" -> ");
}
