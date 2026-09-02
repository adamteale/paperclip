-- Heartbeat-run context lookups (task-watchdogs collectCompletedRunIds, and any
-- consumer filtering on context_snapshot->>'issueId'/'taskId') full-scan the
-- company's heartbeat_runs table because the JSONB extraction has no index.
-- During wake storms this ran 6x concurrently at ~40% CPU per backend and
-- saturated the host (load 48-62 on 16 cores, 2026-09-02).
CREATE INDEX IF NOT EXISTS "heartbeat_runs_ctx_issue_id_idx" ON "heartbeat_runs" (("context_snapshot" ->> 'issueId'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_ctx_task_id_idx" ON "heartbeat_runs" (("context_snapshot" ->> 'taskId'));