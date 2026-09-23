DELETE FROM "cost_events" WHERE "issue_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "issues" i WHERE i."id" = "cost_events"."issue_id");
DELETE FROM "feedback_votes" WHERE "issue_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "issues" i WHERE i."id" = "feedback_votes"."issue_id");
DELETE FROM "finance_events" WHERE "issue_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "issues" i WHERE i."id" = "finance_events"."issue_id");
DELETE FROM "issue_comments" WHERE "issue_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "issues" i WHERE i."id" = "issue_comments"."issue_id");
DELETE FROM "issue_inbox_archives" WHERE "issue_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "issues" i WHERE i."id" = "issue_inbox_archives"."issue_id");
DELETE FROM "issue_read_states" WHERE "issue_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "issues" i WHERE i."id" = "issue_read_states"."issue_id");
DELETE FROM "issue_thread_interactions" WHERE "issue_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "issues" i WHERE i."id" = "issue_thread_interactions"."issue_id");
--> statement-breakpoint
ALTER TABLE "cost_events" DROP CONSTRAINT IF EXISTS "cost_events_issue_id_issues_id_fk";
--> statement-breakpoint
ALTER TABLE "feedback_votes" DROP CONSTRAINT IF EXISTS "feedback_votes_issue_id_issues_id_fk";
--> statement-breakpoint
ALTER TABLE "finance_events" DROP CONSTRAINT IF EXISTS "finance_events_issue_id_issues_id_fk";
--> statement-breakpoint
ALTER TABLE "issue_comments" DROP CONSTRAINT IF EXISTS "issue_comments_issue_id_issues_id_fk";
--> statement-breakpoint
ALTER TABLE "issue_inbox_archives" DROP CONSTRAINT IF EXISTS "issue_inbox_archives_issue_id_issues_id_fk";
--> statement-breakpoint
ALTER TABLE "issue_read_states" DROP CONSTRAINT IF EXISTS "issue_read_states_issue_id_issues_id_fk";
--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" DROP CONSTRAINT IF EXISTS "issue_thread_interactions_issue_id_issues_id_fk";
--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_votes" ADD CONSTRAINT "feedback_votes_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_inbox_archives" ADD CONSTRAINT "issue_inbox_archives_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_read_states" ADD CONSTRAINT "issue_read_states_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;