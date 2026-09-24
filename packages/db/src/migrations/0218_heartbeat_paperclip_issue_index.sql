-- Re-add of the 0215-slot migration lost in the v2026.916.1 rebase (the
-- upstream 0215_flat_daimon_hellstrom took the slot). Follow-up to the
-- 0214-class fix: the liveness/runs queries OR an indexed issueId arm with
-- this unindexed paperclipIssue->>id arm, forcing a seq scan that detoasts
-- every ~35KB context_snapshot in heartbeat_runs. 2026-09-22 (DAI): 10+
-- concurrent backends stacked on that scan drove load ~11 on 4 vCPUs and
-- /api/health to 2.7s TTFB. IF NOT EXISTS keeps it idempotent for instances
-- (DAI) where the index was already created by hand.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_ctx_papissue_created_idx" ON "heartbeat_runs" ("company_id", (("context_snapshot" -> 'paperclipIssue' ->> 'id')), "created_at" DESC);
