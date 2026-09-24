import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  agentWakeupRequests,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
  type Db,
} from "@paperclipai/db";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";
import { sanitizeQuarantinedCommentForHigherTrust } from "./source-trust.js";
import { hasConversationContinuationPolicy } from "./conversation-continuation.js";
import { queuedCommentIdsFromWakePayload } from "./issue-queued-comment-queue.js";

const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const string = (v: unknown) =>
  typeof v === "string" && v.length > 0 ? v : null;

// ── Bounded message history (2026-09-24, DAI wave) ────────────────────────
// The envelope's `messages` array carries the FULL body of every comment on
// the issue. On long-running tickets that accumulates past the kernel's
// 128KB MAX_ARG_STRLEN when the wake payload is serialized into the child
// env (see pi-local execute.ts), and it multiplies every turn's input tokens
// (~230K+ tokens of re-read history per run measured on DF-247/248/249).
//
// Deterministic bounding: the most recent messages keep full bodies (the
// latest directive/verdict is the working context); older bodies are capped
// with a pointer to the full text, which lives on the ticket itself. Same
// inputs → same truncation, so the resumeDelta dedup comparison against the
// prior run's envelope stays consistent.
const CONTINUATION_MAX_CHARS = Number(
  process.env.PAPERCLIP_EXECUTION_CONTINUATION_MAX_CHARS ?? 96_000,
);
const CONTINUATION_OLD_BODY_CAP = 2_000;
const CONTINUATION_KEEP_RECENT_FULL = 6;
const CONTINUATION_LAST_BODY_HARD_CAP = 16_000;

function boundContinuationMessages<T extends { body: string; id: string }>(
  messages: T[],
): { messages: T[]; truncatedCount: number } {
  const bodies = messages.map((m) => m.body ?? "");
  const total = bodies.reduce((n, b) => n + b.length, 0);
  if (total <= CONTINUATION_MAX_CHARS || messages.length === 0) {
    return { messages, truncatedCount: 0 };
  }
  const out = messages.map((m, i) => ({ ...m }));
  const keepFullFrom = Math.max(0, messages.length - CONTINUATION_KEEP_RECENT_FULL);
  let budget =
    CONTINUATION_MAX_CHARS -
    out
      .slice(keepFullFrom)
      .reduce((n, m) => n + (m.body?.length ?? 0), 0);
  let truncatedCount = 0;
  for (let i = 0; i < keepFullFrom; i++) {
    budget -= out[i].body?.length ?? 0;
    if (budget < 0 && (out[i].body?.length ?? 0) > CONTINUATION_OLD_BODY_CAP) {
      out[i].body =
        out[i].body.slice(0, CONTINUATION_OLD_BODY_CAP) +
        `\n
[truncated — full text: comment ${out[i].id} on this ticket]`;
      truncatedCount++;
      budget += CONTINUATION_OLD_BODY_CAP;
    }
  }
  // Hard cap even the kept-recent bodies (oldest first), except the very last
  // message which only yields to a larger emergency cap — the freshest
  // directive/verdict is the working context and must stay readable.
  for (let i = keepFullFrom; i < out.length - 1; i++) {
    if ((out[i].body?.length ?? 0) > CONTINUATION_OLD_BODY_CAP) {
      out[i].body =
        out[i].body.slice(0, CONTINUATION_OLD_BODY_CAP) +
        `\n
[truncated — full text: comment ${out[i].id} on this ticket]`;
      truncatedCount++;
    }
  }
  const last = out[out.length - 1];
  if ((last.body?.length ?? 0) > CONTINUATION_LAST_BODY_HARD_CAP) {
    last.body =
      last.body.slice(0, CONTINUATION_LAST_BODY_HARD_CAP) +
      `\n
[truncated — full text: comment ${last.id} on this ticket]`;
    truncatedCount++;
  }
  return { messages: out, truncatedCount };
}
export function continuationOriginCommentIds(context: unknown): string[] {
  const c = object(context);
  const prior = object(c.executionContinuation);
  return [
    ...new Set(
      [
        c.commentId,
        c.latestCommentId,
        ...(Array.isArray(c.commentIds) ? c.commentIds : []),
        ...(Array.isArray(c.wakeCommentIds) ? c.wakeCommentIds : []),
        ...(Array.isArray(prior.originCommentIds)
          ? prior.originCommentIds
          : []),
      ].filter((v): v is string => typeof v === "string" && v.length > 0),
    ),
  ];
}

/** Also retain user direction delivered after the source run's initial wake. */
export async function currentContinuationOrigins(
  db: Db,
  companyId: string,
  issueId: string,
  context: unknown,
): Promise<string[]> {
  const [latest] = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        eq(issueComments.issueId, issueId),
        isNotNull(issueComments.authorUserId),
        isNull(issueComments.createdByRunId),
        isNull(issueComments.authorAgentId),
        isNull(issueComments.deletedAt),
      ),
    )
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
    .limit(1);
  return [
    ...new Set([
      ...continuationOriginCommentIds(context),
      ...(latest ? [latest.id] : []),
    ]),
  ];
}

/** Re-read task scope at dispatch, including messages already delivered to an earlier provider session. */
export async function buildExecutionContinuation(input: {
  db: Db;
  companyId: string;
  issueId: string;
  agentId: string;
  context: Record<string, unknown>;
  previousContextRunId?: string | null;
  /** Server-owned current run identity when validating dispatch authority. */
  runId?: string;
  summary: string | null;
  exposeLowTrustRaw: boolean;
}): Promise<ExecutionContinuationEnvelope> {
  const { db, companyId, issueId } = input;
  const [issue] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  if (
    !issue ||
    issue.assigneeAgentId !== input.agentId ||
    ["done", "cancelled"].includes(issue.status)
  )
    throw new Error("continuation_task_ownership_changed");
  const rows = await db
    .select()
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        eq(issueComments.issueId, issueId),
      ),
    )
    .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
  const interactions = await db
    .select()
    .from(issueThreadInteractions)
    .where(
      and(
        eq(issueThreadInteractions.companyId, companyId),
        eq(issueThreadInteractions.issueId, issueId),
      ),
    )
    .orderBy(
      asc(issueThreadInteractions.createdAt),
      asc(issueThreadInteractions.id),
    );
  const triggerInteraction = interactions.find(
    (row) => row.id === input.context.interactionId,
  );
  const explicitContinuation = object(input.context.explicitUserContinuation);
  const explicitUserSource = string(explicitContinuation.previousRunId);
  const sourceRunId =
    explicitUserSource ??
    triggerInteraction?.sourceRunId ??
    string(input.context.retryOfRunId) ??
    string(input.context.previousRunId) ??
    string(input.context.interruptedRunId);
  const sourceRun = sourceRunId
    ? (
        await db
          .select({ context: heartbeatRuns.contextSnapshot, result: heartbeatRuns.resultJson })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              eq(heartbeatRuns.id, sourceRunId),
              sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
            ),
          )
      )[0]
    : null;
  if (sourceRunId && !sourceRun)
    throw new Error(explicitUserSource ? "continuation_user_authorization_missing" : "continuation_source_context_missing");
  const originCommentIds = [
    ...new Set([
      ...continuationOriginCommentIds(input.context),
      ...continuationOriginCommentIds(sourceRun?.context),
      ...(triggerInteraction?.originCommentIds ?? []),
      ...(triggerInteraction?.sourceCommentId
        ? [triggerInteraction.sourceCommentId]
        : []),
    ]),
  ];
  // Missing source rows cannot silently become a claim of complete context.
  if (originCommentIds.some((id) => !rows.some((row) => row.id === id)))
    throw new Error("continuation_source_context_missing");
  const messages = rows.map((row) => {
    const safe = input.exposeLowTrustRaw
      ? row
      : sanitizeQuarantinedCommentForHigherTrust(row);
    return {
      id: row.id,
      authorType:
        row.authorType ??
        (row.authorUserId ? "user" : row.authorAgentId ? "agent" : "system"),
      authorId: row.authorUserId ?? row.authorAgentId,
      createdByRunId: row.createdByRunId,
      body: row.deletedAt ? "" : safe.body,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      deleted: row.deletedAt !== null,
      sourceTrust: row.sourceTrust,
    };
  });
  const bounded = boundContinuationMessages(messages);
  const previousRun = input.previousContextRunId
    ? (
        await db
          .select({ context: heartbeatRuns.contextSnapshot })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              eq(heartbeatRuns.agentId, input.agentId),
              eq(heartbeatRuns.id, input.previousContextRunId),
              sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
            ),
          )
      )[0]
    : null;
  const priorEnvelope = object(previousRun?.context?.executionContinuation);
  const deliveredMessages = Array.isArray(priorEnvelope.messages)
    ? priorEnvelope.messages.map(object)
    : null;
  const resumeDelta =
    deliveredMessages && input.previousContextRunId
      ? {
          baseRunId: input.previousContextRunId,
          messages: bounded.messages.filter(
            (message) =>
              originCommentIds.includes(message.id) ||
              !deliveredMessages.some(
                (prior) =>
                  prior.id === message.id &&
                  prior.updatedAt === message.updatedAt &&
                  prior.body === message.body &&
                  prior.deleted === message.deleted &&
                  prior.authorId === message.authorId &&
                  (prior.createdByRunId ?? null) === message.createdByRunId &&
                  JSON.stringify(prior.sourceTrust) ===
                    JSON.stringify(message.sourceTrust),
              ),
          ),
        }
      : undefined;
  const latestRequest = bounded.messages.findLast(
    (row) =>
      row.authorType === "user" && !row.createdByRunId && !row.deleted && row.body.trim().length > 0,
  );
  const priorRuns = await db
    .select({ id: heartbeatRuns.id, result: heartbeatRuns.resultJson, status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, runtimeMode: heartbeatRuns.runtimeMode, retryOfRunId: heartbeatRuns.retryOfRunId })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        or(eq(heartbeatRuns.agentId, input.agentId),
          sourceRunId ? eq(heartbeatRuns.id, sourceRunId) : undefined),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
      ),
    )
    .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id));
  const completedActions = priorRuns.flatMap((run) =>
    Object.entries(object(object(run.result).apiToolReceipts)).flatMap(
      ([receiptId, receipt]) => {
        const value = object(receipt);
        return value.state === "completed" &&
          typeof value.operationId === "string"
          ? [
              {
                runId: run.id,
                receiptId,
                operationId: value.operationId,
                result: value.result,
              },
            ]
          : [];
      },
    ),
  );
  const reconciliations = await db
    .select({
      id: issueRecoveryActions.id,
      evidence: issueRecoveryActions.evidence,
    })
    .from(issueRecoveryActions)
    .where(
      and(
        eq(issueRecoveryActions.companyId, companyId),
        eq(issueRecoveryActions.sourceIssueId, issueId),
        eq(issueRecoveryActions.status, "resolved"),
      ),
    );
  const lastTerminal = priorRuns.findLast((run) =>
    ["succeeded", "failed", "timed_out", "interrupted", "cancelled"].includes(run.status) &&
    !(run.status === "cancelled" && run.errorCode === "execution_reconciliation_required"),
  );
  if (explicitUserSource) {
    const predecessor = priorRuns.find(run => run.id === explicitUserSource &&
      ["failed", "timed_out", "interrupted", "cancelled"].includes(run.status));
    const failedRunId = string(explicitContinuation.failedRunId);
    const retryWakes = failedRunId ? await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, input.agentId),
      eq(agentWakeupRequests.reason, "retry_failed_run"), eq(agentWakeupRequests.requestedByActorType, "user"),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
    )) : [];
    // Admission records the board operator's authority separately from the
    // message author. At dispatch, prove that exact queue was adopted by this
    // run; caller-supplied continuation context cannot grant this authority.
    const continuationAuthorizations = reconciliations.map(row => object(row.evidence.explicitUserContinuation))
      .filter(value => value.previousRunId === explicitUserSource &&
        (!input.runId || value.runId === input.runId) &&
        value.commentId === explicitContinuation.commentId &&
        priorRuns.some(run => run.id === value.runId));
    const interruptQueueIds = [...new Set(continuationAuthorizations.flatMap(value => {
      const parsed = z.string().guid().safeParse(value.queuedCommentInterruptId);
      return parsed.success ? [parsed.data] : [];
    }))];
    const interruptQueues = interruptQueueIds.length
      ? await db.select().from(agentWakeupRequests).where(and(
        inArray(agentWakeupRequests.id, interruptQueueIds),
        eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, input.agentId),
        eq(agentWakeupRequests.status, "coalesced"),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
        sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt' is not null`,
        input.runId ? eq(agentWakeupRequests.runId, input.runId) : undefined,
      )) : [];
    const authorization = continuationAuthorizations.find(value => failedRunId
          ? value.failedRunId === failedRunId && retryWakes.some(wake =>
              wake.runId === value.runId && wake.requestedByActorId === value.actorId &&
              priorRuns.some(run => run.id === wake.runId && run.retryOfRunId === failedRunId))
          : rows.some(comment => comment.id === value.commentId &&
              comment.authorType === "user" &&
              (value.queuedCommentInterruptId
                ? interruptQueues.some(queue => queue.id === value.queuedCommentInterruptId &&
                    queue.runId === value.runId &&
                    object(object(queue.payload).queuedCommentInterrupt).actorId === value.actorId &&
                    queuedCommentIdsFromWakePayload(queue.payload).includes(comment.id))
                : comment.authorUserId === value.actorId) &&
              !comment.createdByRunId && !comment.deletedAt));
    if (!predecessor || !authorization || explicitUserSource !== sourceRunId)
      throw new Error("continuation_user_authorization_missing");
  }
  const interruptedRunId = explicitUserSource ?? string(input.context.interruptedRunId) ?? (lastTerminal && lastTerminal.status !== "succeeded" &&
    (hasConversationContinuationPolicy(lastTerminal.result) ||
      lastTerminal.status === "interrupted" || lastTerminal.errorCode === "process_lost")
    ? lastTerminal.id : undefined);
  return {
    ...(interruptedRunId ? { interruptedRunId } : {}),
    ...(resumeDelta ? { resumeDelta } : {}),
    ...(bounded.truncatedCount > 0
      ? {
          truncation: {
            truncatedMessages: bounded.truncatedCount,
            maxChars: CONTINUATION_MAX_CHARS,
            note: "older comment bodies capped; full text on the ticket",
          },
        }
      : {}),
    recoveryOutcomes: reconciliations
      .filter((row) => row.evidence.executionReconciliation)
      .map((row) => ({
        recoveryActionId: row.id,
        decision: row.evidence.executionReconciliation,
      })),
    version: 1,
    companyId,
    issueId,
    trigger: {
      reason: string(input.context.wakeReason) ?? "task_execution",
      interactionId: triggerInteraction?.id ?? null,
      sourceRunId,
    },
    originCommentIds,
    objective: (latestRequest?.body ?? issue.description ?? issue.title)?.slice(
      0,
      8_000,
    ),
    messages: bounded.messages,
    interactionOutcomes: interactions
      .filter((row) => row.status !== "pending")
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        status: row.status,
        result: row.result,
      })),
    // Low-trust evidence only: renderPaperclipWakePrompt removes completedWork
    // from requestContext and encodes it in the fenced, non-authoritative
    // continuation-evidence section. It cannot supply objective or authority.
    completedWork: input.summary ??
      string(object(object(sourceRun?.result).nativeResult).summary)?.slice(0, 32_000) ??
      string(object(sourceRun?.result).summary)?.slice(0, 32_000) ?? null,
    completedActions,
    unresolvedInteractionIds: interactions
      .filter((row) => row.status === "pending")
      .map((row) => row.id),
    coverage: {
      kind: bounded.truncatedCount > 0 ? "bounded_task_history" : "full_task_history",
      throughCommentId: bounded.messages.at(-1)?.id ?? null,
      summaryThroughCommentId: null,
    },
  };
}
