import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildPaperclipWakePayload } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wake brief delivery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Regression: 2026-08-26 (DAI). Routine stage-entry dispatch briefs are
// system-authored comments. They were capped at the human-comment body budget
// (4k chars / 12k total), so a 21.6k-char QA routine reached the agent as a
// 4k slice ending mid-sentence in CHECK 1 — the agent never saw the
// stage-transition instructions and the case stranded at qa_review for hours.
describeEmbeddedPostgres("wake payload dispatch brief delivery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wake-brief-");
    db = createDb(tempDb.connectionString);
    await db.execute(sql.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm"));
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(options: { originKind?: string; description?: string } = {}) {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Wake Brief Co",
      issuePrefix: `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "WB-1",
      title: "Wake brief delivery",
      status: "todo",
      priority: "medium",
      description: options.description ?? null,
      originKind: options.originKind ?? "manual",
    });
    return { companyId, issueId };
  }

  it("delivers a 21k system dispatch brief whole instead of a 4k slice", async () => {
    const { companyId, issueId } = await seedIssue();
    const briefId = randomUUID();
    const briefBody = `## QA brief\n\n${"CHECK n — verify the thing and quote evidence. ".repeat(470)}`;
    expect(briefBody.length).toBeGreaterThan(21_000);
    await db.insert(issueComments).values({
      id: briefId,
      companyId,
      issueId,
      authorType: "system",
      body: briefBody,
    });

    const wakePayload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        issueId,
        wakeCommentIds: [briefId],
        wakeCommentId: briefId,
        wakeReason: "issue_assigned",
        source: "routine.dispatch",
      },
    });

    expect(wakePayload?.comments).toHaveLength(1);
    const delivered = wakePayload?.comments[0] as { body: string; bodyTruncated: boolean };
    expect(delivered.bodyTruncated).toBe(false);
    expect(delivered.body).toBe(briefBody);
  });

  it("does not let a system brief consume the human/agent comment body budget", async () => {
    const { companyId, issueId } = await seedIssue();
    const briefId = randomUUID();
    const humanId = randomUUID();
    await db.insert(issueComments).values([
      {
        id: briefId,
        companyId,
        issueId,
        authorType: "system",
        body: "system brief ".repeat(2_000), // 28k chars — far over the 12k total budget
      },
      {
        id: humanId,
        companyId,
        issueId,
        authorUserId: "board-user-1",
        body: "human asks: please fix the CTA contrast",
      },
    ]);

    const wakePayload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        issueId,
        wakeCommentIds: [briefId, humanId],
        wakeReason: "issue_commented",
      },
    });

    const delivered = wakePayload?.comments as Array<{ id: string; body: string; bodyTruncated: boolean }>;
    expect(delivered).toHaveLength(2);
    expect(delivered.find((comment) => comment.id === briefId)?.bodyTruncated).toBe(false);
    expect(delivered.find((comment) => comment.id === humanId)?.body).toBe("human asks: please fix the CTA contrast");
  });

  it("still truncates oversized human comments at the 4k body cap", async () => {
    const { companyId, issueId } = await seedIssue();
    const humanId = randomUUID();
    await db.insert(issueComments).values({
      id: humanId,
      companyId,
      issueId,
      authorUserId: "board-user-1",
      body: "x".repeat(5_000),
    });

    const wakePayload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        issueId,
        wakeCommentIds: [humanId],
        wakeReason: "issue_commented",
      },
    });

    const delivered = wakePayload?.comments[0] as { body: string; bodyTruncated: boolean };
    expect(delivered.bodyTruncated).toBe(true);
    expect(delivered.body.length).toBe(4_000);
  });

  it("delivers a routine-execution issue description whole beyond the 12k inline cap", async () => {
    const longDescription = "step ".repeat(3_000); // 15k chars
    const { companyId, issueId } = await seedIssue({
      originKind: "routine_execution",
      description: longDescription,
    });

    const wakePayload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
        source: "routine.dispatch",
      },
    });

    expect(wakePayload?.issue?.description).toBe(longDescription);
    expect(wakePayload?.issue?.descriptionTruncated).toBe(false);
  });

  it("still truncates a regular issue description at the 12k inline cap", async () => {
    const longDescription = "y".repeat(13_000);
    const { companyId, issueId } = await seedIssue({ description: longDescription });

    const wakePayload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
    });

    expect(wakePayload?.issue?.descriptionTruncated).toBe(true);
    expect(wakePayload?.issue?.description?.length).toBe(12_000);
  });
});
