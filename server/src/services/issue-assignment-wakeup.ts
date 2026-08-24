import { logger } from "../middleware/logger.js";

type WakeupTriggerDetail = "manual" | "ping" | "callback" | "system";
type WakeupSource = "timer" | "assignment" | "on_demand" | "automation";

export interface IssueAssignmentWakeupDeps {
  wakeup: (
    agentId: string,
    opts: {
      source?: WakeupSource;
      triggerDetail?: WakeupTriggerDetail;
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
}

// dispatchRoutineRun (routines.ts) awaits this call from inside a db.transaction()
// that is already holding a `for update` lock on the triggering routine's row. Any
// stall inside heartbeat.wakeup (itself capable of opening further transactions/locks,
// e.g. on the issues table) keeps that outer transaction — and its row lock — open
// indefinitely, which has caused company-wide routine-dispatch pileups in production
// (2026-08-24, DAI). Bound the wait so the outer transaction can always proceed.
const WAKEUP_TIMEOUT_MS = 8_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function queueIssueAssignmentWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: { id: string; assigneeAgentId: string | null; status: string };
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  taskKey?: string | null;
  rethrowOnError?: boolean;
}) {
  if (!input.issue.assigneeAgentId || input.issue.status === "backlog") return;

  return withTimeout(
    input.heartbeat.wakeup(input.issue.assigneeAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: input.reason,
      payload: {
        issueId: input.issue.id,
        mutation: input.mutation,
        ...(input.taskKey ? { taskKey: input.taskKey } : {}),
      },
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId ?? null,
      contextSnapshot: {
        issueId: input.issue.id,
        source: input.contextSource,
        ...(input.taskKey ? { taskKey: input.taskKey } : {}),
      },
    }),
    WAKEUP_TIMEOUT_MS,
    "issue assignment wakeup",
  ).catch((err) => {
    logger.warn({ err, issueId: input.issue.id }, "failed to wake assignee on issue assignment");
    if (input.rethrowOnError) throw err;
    return null;
  });
}
