import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  goals,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { createIssueThreadInteractionSchema } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import {
  extractGitHubPullRequestReferences,
  getMergeConfirmationPullRequestReferences,
  issueThreadInteractionService,
} from "../services/issue-thread-interactions.js";
import {
  PULL_REQUEST_CACHE_MAX_ENTRIES,
  setBoundedPullRequestCacheEntry,
} from "../services/github-pull-request-merge.js";
import {
  createGiteaPullRequestMergeDetailsResolver,
  extractGiteaPullRequestReferences,
} from "../services/gitea-pull-request-merge.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

describe("merged pull-request confirmation extraction", () => {
  it("bounds shared pull-request state caches", () => {
    const cache = new Map<string, number>();
    for (let index = 0; index <= PULL_REQUEST_CACHE_MAX_ENTRIES; index += 1) {
      setBoundedPullRequestCacheEntry(cache, `pr-${index}`, index);
    }

    expect(cache.size).toBe(PULL_REQUEST_CACHE_MAX_ENTRIES);
    expect(cache.has("pr-0")).toBe(false);
    expect(cache.get(`pr-${PULL_REQUEST_CACHE_MAX_ENTRIES}`)).toBe(PULL_REQUEST_CACHE_MAX_ENTRIES);
  });

  it("extracts and deduplicates full GitHub URLs and owner/repo#N shorthand", () => {
    expect(extractGitHubPullRequestReferences([
      "Merge https://github.com/PaperclipAI/paperclip/pull/39.",
      "Also paperclipai/paperclip#40 and PAPERCLIPAI/paperclip#40.",
    ])).toEqual([
      { provider: "github", host: "github.com", owner: "PaperclipAI", repo: "paperclip", number: 39 },
      { provider: "github", host: "github.com", owner: "paperclipai", repo: "paperclip", number: 40 },
    ]);
  });

  it("requires merge intent and excludes document and tool-action confirmations", () => {
    const base = {
      kind: "request_confirmation",
      title: "Merge PaperclipAI/paperclip#39?",
      summary: null,
      payload: { version: 1, prompt: "Merge the pull request?" },
    } as const;
    expect(getMergeConfirmationPullRequestReferences(base)).toHaveLength(1);
    expect(getMergeConfirmationPullRequestReferences({
      ...base,
      title: "Approve the release?",
    })).toEqual([]);
    expect(getMergeConfirmationPullRequestReferences({
      ...base,
      payload: { ...base.payload, target: { type: "issue_document", key: "plan" } },
    })).toEqual([]);
    expect(getMergeConfirmationPullRequestReferences({
      ...base,
      payload: { ...base.payload, toolAction: { actionRequestId: "action-1" } },
    })).toEqual([]);
  });

  it("finds references in merge-confirmation body and custom target fields", () => {
    expect(getMergeConfirmationPullRequestReferences({
      kind: "request_confirmation",
      title: "Merge the linked PR?",
      summary: "The checks are green.",
      payload: {
        version: 1,
        prompt: "Merge the linked pull request?",
        detailsMarkdown: "Primary: paperclipai/paperclip#39",
        target: {
          type: "custom",
          key: "github-pr-40",
          href: "https://github.com/paperclipai/paperclip/pull/40",
        },
      },
    })).toEqual([
      { provider: "github", host: "github.com", owner: "paperclipai", repo: "paperclip", number: 39 },
      { provider: "github", host: "github.com", owner: "paperclipai", repo: "paperclip", number: 40 },
    ]);
  });

  it("denies governed actions mentioned in details or custom target metadata", () => {
    const base = {
      kind: "request_confirmation",
      title: "Merge the linked PR?",
      summary: "The checks are green.",
    } as const;
    expect(getMergeConfirmationPullRequestReferences({
      ...base,
      payload: {
        version: 1,
        prompt: "Merge the linked pull request?",
        detailsMarkdown: "Deploy to production after paperclipai/paperclip#39 merges.",
      },
    })).toEqual([]);
    expect(getMergeConfirmationPullRequestReferences({
      ...base,
      payload: {
        version: 1,
        prompt: "Merge the linked pull request?",
        target: {
          type: "custom",
          label: "Release to production",
          href: "https://github.com/paperclipai/paperclip/pull/39",
        },
      },
    })).toEqual([]);
  });

  it("fails closed when a merge confirmation includes an additional action clause", () => {
    expect(getMergeConfirmationPullRequestReferences({
      kind: "request_confirmation",
      title: "Merge the linked PR?",
      summary: null,
      payload: {
        version: 1,
        prompt: "Merge paperclipai/paperclip#39?",
        detailsMarkdown: "Erase all customer records after paperclipai/paperclip#39 merges.",
      },
    })).toEqual([]);
  });
});

describe("gitea merge-confirmation extraction", () => {
  const INTERNAL = "http://192.168.100.92:3002";
  const PUBLIC = "https://robotpants.ddns.net:9443";
  const previous = { url: process.env.GITEA_URL, publicUrl: process.env.GITEA_PUBLIC_URL };

  beforeAll(() => {
    process.env.GITEA_URL = INTERNAL;
    process.env.GITEA_PUBLIC_URL = PUBLIC;
  });

  afterAll(() => {
    if (previous.url === undefined) delete process.env.GITEA_URL;
    else process.env.GITEA_URL = previous.url;
    if (previous.publicUrl === undefined) delete process.env.GITEA_PUBLIC_URL;
    else process.env.GITEA_PUBLIC_URL = previous.publicUrl;
  });

  it("extracts PR references from both configured Gitea origins and ignores unknown hosts", () => {
    expect(extractGiteaPullRequestReferences([
      `Merge ${INTERNAL}/admin/tsa-monorepo/pulls/12`,
      `Merge ${PUBLIC}/admin/tsa-monorepo/pulls/13`,
      // Unknown host: never trusted, even with an identical path shape.
      "Merge https://gitea.evil.example/admin/tsa-monorepo/pulls/14",
      // Look-alike host suffix must not match the configured origin either.
      "Merge http://192.168.100.92:3002.evil.example/admin/tsa-monorepo/pulls/15",
    ])).toEqual([
      { provider: "gitea", host: "192.168.100.92:3002", baseUrl: INTERNAL, owner: "admin", repo: "tsa-monorepo", number: 12 },
      { provider: "gitea", host: "robotpants.ddns.net:9443", baseUrl: PUBLIC, owner: "admin", repo: "tsa-monorepo", number: 13 },
    ]);
  });

  it("does not treat GitHub's singular /pull/ path as a Gitea reference", () => {
    expect(extractGiteaPullRequestReferences([`${INTERNAL}/admin/tsa-monorepo/pull/12`])).toEqual([]);
  });

  it("accepts a Gitea merge confirmation through the same fail-closed gauntlet", () => {
    expect(getMergeConfirmationPullRequestReferences({
      kind: "request_confirmation",
      title: `Merge ${INTERNAL}/admin/tsa-monorepo/pulls/12?`,
      summary: "The checks are green.",
      payload: { version: 1, prompt: "Merge the pull request?" },
    })).toEqual([
      { provider: "gitea", host: "192.168.100.92:3002", baseUrl: INTERNAL, owner: "admin", repo: "tsa-monorepo", number: 12 },
    ]);
  });

  it("rejects a Gitea reference smuggled into a tool-action or document confirmation", () => {
    const base = {
      kind: "request_confirmation",
      title: `Merge ${INTERNAL}/admin/tsa-monorepo/pulls/12?`,
      summary: null,
      payload: { version: 1, prompt: "Merge the pull request?" },
    } as const;
    expect(getMergeConfirmationPullRequestReferences(base)).toHaveLength(1);
    expect(getMergeConfirmationPullRequestReferences({
      ...base,
      payload: { ...base.payload, toolAction: { actionRequestId: "action-1" } },
    })).toEqual([]);
    expect(getMergeConfirmationPullRequestReferences({
      ...base,
      payload: { ...base.payload, target: { type: "issue_document", key: "plan" } },
    })).toEqual([]);
    // No merge intent → not a merge confirmation.
    expect(getMergeConfirmationPullRequestReferences({
      ...base,
      title: `Approve the release ${INTERNAL}/admin/tsa-monorepo/pulls/12`,
      payload: { version: 1, prompt: "Approve the release?" },
    })).toEqual([]);
    // Extra action clause alongside a valid Gitea merge prompt.
    expect(getMergeConfirmationPullRequestReferences({
      ...base,
      payload: {
        ...base.payload,
        detailsMarkdown: `Erase all customer records after ${INTERNAL}/admin/tsa-monorepo/pulls/12 merges.`,
      },
    })).toEqual([]);
  });

  it("resolves merge state from the Gitea API with token auth", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const resolve = createGiteaPullRequestMergeDetailsResolver(null as never, {
      tokenProvider: () => "gitea-token",
      fetch: async (url, init) => {
        calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
        const number = Number(url.split("/").pop());
        return new Response(
          JSON.stringify({
            // Gitea 1.27 exposes `merged` + `state`; there is no mergeable_state.
            merged: number === 12,
            state: number === 12 ? "closed" : "open",
            head: { ref: "DAI-1-feature", sha: "abc123" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const reference = {
      provider: "gitea" as const,
      host: "192.168.100.92:3002",
      baseUrl: INTERNAL,
      owner: "admin",
      repo: "tsa-monorepo",
      number: 12,
    };
    await expect(resolve("company-1", reference)).resolves.toEqual({
      state: "merged",
      headRef: "DAI-1-feature",
      headSha: "abc123",
    });
    expect(calls[0]!.url).toBe(`${INTERNAL}/api/v1/repos/admin/tsa-monorepo/pulls/12`);
    expect(calls[0]!.headers.authorization).toBe("token gitea-token");

    await expect(resolve("company-1", { ...reference, number: 13 })).resolves.toMatchObject({ state: "open" });
  });

  it("warns with the host and reason when the Gitea endpoint cannot be reached", async () => {
    // Silent degradation is the risk: on an instance without branch protection
    // the sweep is the only thing advancing cases on merge, so a TLS or auth
    // failure must not look like "not merged yet".
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    try {
      const reference = {
        provider: "gitea" as const,
        host: "robotpants.ddns.net:9443",
        baseUrl: PUBLIC,
        owner: "admin",
        repo: "tsa-monorepo",
        number: 12,
      };

      const tlsFailure = createGiteaPullRequestMergeDetailsResolver(null as never, {
        tokenProvider: () => "gitea-token",
        fetch: async () => { throw new Error("unable to verify the first certificate"); },
      });
      await expect(tlsFailure("company-1", reference)).resolves.toMatchObject({ state: "unknown" });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "request_failed",
          host: "robotpants.ddns.net:9443",
          repo: "admin/tsa-monorepo",
          pullRequestNumber: 12,
        }),
        expect.stringContaining("left pending"),
      );

      warn.mockClear();
      const authFailure = createGiteaPullRequestMergeDetailsResolver(null as never, {
        tokenProvider: () => "stale-token",
        fetch: async () => new Response("unauthorized", { status: 401 }),
      });
      await expect(authFailure("company-1", reference)).resolves.toMatchObject({ state: "unknown" });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "http_error", status: 401, hasToken: true }),
        expect.any(String),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("reports unknown (never merged) for API failures and untrusted origins", async () => {
    const failing = createGiteaPullRequestMergeDetailsResolver(null as never, {
      tokenProvider: () => "gitea-token",
      fetch: async () => new Response("nope", { status: 500 }),
    });
    const reference = {
      provider: "gitea" as const,
      host: "192.168.100.92:3002",
      baseUrl: INTERNAL,
      owner: "admin",
      repo: "tsa-monorepo",
      number: 12,
    };
    await expect(failing("company-1", reference)).resolves.toEqual({
      state: "unknown",
      headRef: null,
      headSha: null,
    });

    // A reference whose origin is no longer configured must not be fetched at
    // all — credentials never travel to an untrusted host.
    let fetched = false;
    const untrusted = createGiteaPullRequestMergeDetailsResolver(null as never, {
      tokenProvider: () => "gitea-token",
      fetch: async () => {
        fetched = true;
        return new Response("{}", { status: 200 });
      },
    });
    await expect(untrusted("company-1", { ...reference, baseUrl: "https://gitea.evil.example", host: "gitea.evil.example" }))
      .resolves.toMatchObject({ state: "unknown" });
    expect(fetched).toBe(false);
  });

  it("ignores Gitea URLs entirely when no Gitea origin is configured", () => {
    const url = process.env.GITEA_URL;
    const publicUrl = process.env.GITEA_PUBLIC_URL;
    delete process.env.GITEA_URL;
    delete process.env.GITEA_PUBLIC_URL;
    try {
      expect(extractGiteaPullRequestReferences([`Merge ${INTERNAL}/admin/tsa-monorepo/pulls/12`])).toEqual([]);
      expect(getMergeConfirmationPullRequestReferences({
        kind: "request_confirmation",
        title: `Merge ${INTERNAL}/admin/tsa-monorepo/pulls/12?`,
        summary: null,
        payload: { version: 1, prompt: "Merge the pull request?" },
      })).toEqual([]);
    } finally {
      if (url !== undefined) process.env.GITEA_URL = url;
      if (publicUrl !== undefined) process.env.GITEA_PUBLIC_URL = publicUrl;
    }
  });

});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres.sequential("merged pull-request confirmation sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-merged-pr-confirmations-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue() {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "MPR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Ship safely",
      level: "task",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Land the changes",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    return { companyId, goalId, issueId, agentId };
  }

  it("accepts only all-merged cards, wakes the assignee, and audits the system actor", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "MPR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Ship safely",
      level: "task",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Land the changes",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const interactionIds = {
      merged: randomUUID(),
      boardOrAgents: randomUUID(),
      someOpen: randomUUID(),
      zeroRefs: randomUUID(),
      toolAction: randomUUID(),
      extraAction: randomUUID(),
    };
    const common = {
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee_on_accept",
      requestedResolverPolicy: "board_only",
      effectiveResolverPolicy: "board_only",
    } as const;
    await db.insert(issueThreadInteractions).values([
      {
        ...common,
        id: interactionIds.merged,
        title: "Merge https://github.com/paperclipai/paperclip/pull/39?",
        payload: { version: 1, prompt: "Merge the PR?" },
      },
      {
        ...common,
        id: interactionIds.boardOrAgents,
        title: "Merge paperclipai/paperclip#39?",
        requestedResolverPolicy: "board_or_agents",
        effectiveResolverPolicy: "board_or_agents",
        payload: { version: 1, prompt: "Merge the PR?" },
      },
      {
        ...common,
        id: interactionIds.someOpen,
        title: "Ready to merge paperclipai/paperclip#39 and paperclipai/paperclip#41?",
        payload: { version: 1, prompt: "Ready to merge both PRs?" },
      },
      {
        ...common,
        id: interactionIds.zeroRefs,
        title: "Merge the pending PR?",
        payload: { version: 1, prompt: "Merge it?" },
      },
      {
        ...common,
        id: interactionIds.toolAction,
        title: "Merge paperclipai/paperclip#42?",
        payload: {
          version: 1,
          prompt: "Merge the PR?",
          toolAction: { version: 1, actionRequestId: "action-1" },
        },
      },
      {
        ...common,
        id: interactionIds.extraAction,
        title: "Merge the linked PR?",
        payload: {
          version: 1,
          prompt: "Merge paperclipai/paperclip#39?",
          detailsMarkdown: "Erase all customer records after paperclipai/paperclip#39 merges.",
        },
      },
    ]);

    const wakeup = vi.fn(async () => ({ id: "wake-1" }));
    const resolvePullRequestState = vi.fn(async (_resolvedCompanyId: string, reference: { number: number }) =>
      reference.number === 41 ? "open" as const : "merged" as const
    );
    const service = issueThreadInteractionService(db, {
      wakeup,
      resolvePullRequestState,
    });

    await expect(service.sweepMergedPullRequestConfirmations()).resolves.toEqual({
      checked: 6,
      candidates: 3,
      accepted: 2,
      woken: 2,
    });

    const stored = await db
      .select({ id: issueThreadInteractions.id, status: issueThreadInteractions.status })
      .from(issueThreadInteractions)
      .where(inArray(issueThreadInteractions.id, Object.values(interactionIds)));
    expect(new Map(stored.map((row) => [row.id, row.status]))).toEqual(new Map([
      [interactionIds.merged, "accepted"],
      [interactionIds.boardOrAgents, "accepted"],
      [interactionIds.someOpen, "pending"],
      [interactionIds.zeroRefs, "pending"],
      [interactionIds.toolAction, "pending"],
      [interactionIds.extraAction, "pending"],
    ]));
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      requestedByActorType: "system",
      requestedByActorId: "system:pr-merged",
      idempotencyKey: `interaction:${interactionIds.merged}:accepted`,
    }));
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      requestedByActorType: "system",
      requestedByActorId: "system:pr-merged",
      idempotencyKey: `interaction:${interactionIds.boardOrAgents}:accepted`,
    }));
    expect(resolvePullRequestState).toHaveBeenCalledTimes(2);

    const audit = await db.select().from(activityLog);
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorType: "system",
        actorId: "system:pr-merged",
        action: "issue.thread_interaction_accepted",
        entityId: issueId,
        details: expect.objectContaining({
          interactionId: interactionIds.merged,
          resolutionActorKind: "system",
          pullRequests: ["paperclipai/paperclip#39"],
        }),
      }),
    ]));
  });

  it("accepts merged Gitea confirmations and leaves open + untrusted-host ones pending", async () => {
    const internal = "http://192.168.100.92:3002";
    const publicOrigin = "https://robotpants.ddns.net:9443";
    const previous = { url: process.env.GITEA_URL, publicUrl: process.env.GITEA_PUBLIC_URL };
    process.env.GITEA_URL = internal;
    process.env.GITEA_PUBLIC_URL = publicOrigin;
    try {
      const { companyId, issueId, agentId } = await seedIssue();
      const interactionIds = {
        giteaMerged: randomUUID(),
        giteaOpen: randomUUID(),
        untrustedHost: randomUUID(),
      };
      const common = {
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee_on_accept",
        requestedResolverPolicy: "board_only",
        effectiveResolverPolicy: "board_only",
      } as const;
      await db.insert(issueThreadInteractions).values([
        {
          ...common,
          id: interactionIds.giteaMerged,
          // Internal origin — what create_pr posts on ASUS.
          title: `Merge ${internal}/admin/tsa-monorepo/pulls/12?`,
          payload: { version: 1, prompt: "Merge the pull request?" },
        },
        {
          ...common,
          id: interactionIds.giteaOpen,
          // Public origin — what humans see in Slack/comments.
          title: `Merge ${publicOrigin}/admin/tsa-monorepo/pulls/13?`,
          payload: { version: 1, prompt: "Merge the pull request?" },
        },
        {
          ...common,
          id: interactionIds.untrustedHost,
          title: "Merge https://gitea.evil.example/admin/tsa-monorepo/pulls/14?",
          payload: { version: 1, prompt: "Merge the pull request?" },
        },
      ]);

      const wakeup = vi.fn(async () => ({ id: "wake-1" }));
      const resolvePullRequestState = vi.fn(async (
        _companyId: string,
        reference: { provider?: string; number: number },
      ) => (reference.provider === "gitea" && reference.number === 12 ? "merged" as const : "open" as const));
      const service = issueThreadInteractionService(db, { wakeup, resolvePullRequestState });

      await expect(service.sweepMergedPullRequestConfirmations()).resolves.toEqual({
        checked: 3,
        candidates: 2,
        accepted: 1,
        woken: 1,
      });

      const stored = await db
        .select({ id: issueThreadInteractions.id, status: issueThreadInteractions.status })
        .from(issueThreadInteractions)
        .where(inArray(issueThreadInteractions.id, Object.values(interactionIds)));
      expect(new Map(stored.map((row) => [row.id, row.status]))).toEqual(new Map([
        [interactionIds.giteaMerged, "accepted"],
        [interactionIds.giteaOpen, "pending"],
        [interactionIds.untrustedHost, "pending"],
      ]));
      expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
        idempotencyKey: `interaction:${interactionIds.giteaMerged}:accepted`,
      }));

      const audit = await db.select().from(activityLog);
      expect(audit).toEqual(expect.arrayContaining([
        expect.objectContaining({
          action: "issue.thread_interaction_accepted",
          details: expect.objectContaining({
            interactionId: interactionIds.giteaMerged,
            pullRequests: ["192.168.100.92:3002/admin/tsa-monorepo#12"],
          }),
        }),
      ]));
    } finally {
      if (previous.url === undefined) delete process.env.GITEA_URL;
      else process.env.GITEA_URL = previous.url;
      if (previous.publicUrl === undefined) delete process.env.GITEA_PUBLIC_URL;
      else process.env.GITEA_PUBLIC_URL = previous.publicUrl;
    }
  });

  // POLICY: a confirmation needs at least ONE human-readable field, and
  // `payload.prompt` counts. `title` and `summary` are both optional and most
  // agent-created confirmations set neither — on DAI, 48 of 109
  // request_confirmation rows (44%) are prompt-only — and they render fine
  // under the card's generic "Confirmation requested" heading. Any future
  // tightening that demands a title or a summary would 422 nearly half of all
  // confirmations agents create; this test should be the first thing that
  // fails if that is ever attempted. The constraint that actually enforces the
  // policy is `prompt: z.string().trim().min(1)` on
  // requestConfirmationPayloadSchema (packages/shared/src/validators/issue.ts).
  it("policy: prompt-only, title-only and summary-only confirmations are all valid", async () => {
    const { companyId, issueId } = await seedIssue();
    const service = issueThreadInteractionService(db);
    const issue = { id: issueId, companyId };

    // The dominant live shape: prompt only, no title, no summary.
    const promptOnly = await service.create(issue, {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "The bottom-right arrow CTA has been added to CategoryCard. Approve?",
      },
    } as never, {});
    expect(promptOnly.title).toBeNull();
    expect(promptOnly.summary).toBeNull();
    expect(promptOnly.payload.prompt).toContain("CategoryCard");

    const titleOnly = await service.create(issue, {
      kind: "request_confirmation",
      title: "Approve the rollout?",
      payload: { version: 1, prompt: "Approve?" },
    } as never, {});
    expect(titleOnly.title).toBe("Approve the rollout?");

    const summaryOnly = await service.create(issue, {
      kind: "request_confirmation",
      summary: "The rollout plan is in the comment above.",
      payload: { version: 1, prompt: "Approve?" },
    } as never, {});
    expect(summaryOnly.summary).toBe("The rollout plan is in the comment above.");

    // Other kinds are untouched by the guard.
    const question = await service.create(issue, {
      kind: "ask_user_questions",
      payload: {
        version: 1,
        questions: [{
          id: "q1",
          prompt: "Which variant?",
          selectionMode: "single",
          options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
        }],
      },
    } as never, {});
    expect(question.kind).toBe("ask_user_questions");

    const rows = await db
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, issueId));
    expect(rows).toHaveLength(4);
  });
});

// The readability policy is enforced by the payload schema itself, so it is
// tested there rather than through a redundant service-level guard: a
// confirmation with no title and no summary is valid, but one with no readable
// text at all cannot be constructed because `prompt` is required non-empty.
describe("request_confirmation readability policy (schema-enforced)", () => {
  const parse = (input: unknown) => createIssueThreadInteractionSchema.safeParse(input);

  it("accepts a prompt-only confirmation and rejects one with no readable text", () => {
    expect(parse({
      kind: "request_confirmation",
      payload: { version: 1, prompt: "Approve the CategoryCard CTA change?" },
    }).success).toBe(true);

    // No title, no summary and a blank prompt: unreadable, and unconstructible.
    expect(parse({
      kind: "request_confirmation",
      title: "   ",
      summary: "",
      payload: { version: 1, prompt: "   " },
    }).success).toBe(false);

    expect(parse({
      kind: "request_confirmation",
      payload: { version: 1 },
    }).success).toBe(false);
  });
});
