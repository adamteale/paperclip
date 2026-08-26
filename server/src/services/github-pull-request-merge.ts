import type { Db } from "@paperclipai/db";
import { createGitHubExternalObjectProvider } from "./github-external-object-provider.js";
import {
  createGiteaPullRequestMergeDetailsResolver,
  extractGiteaPullRequestReferences,
  type GiteaEnv,
  type GiteaPullRequestReference,
} from "./gitea-pull-request-merge.js";

export type GitHubPullRequestReference = {
  provider: "github";
  host: "github.com";
  owner: string;
  repo: string;
  number: number;
};

/**
 * A PR reference the merge sweep can resolve. GitHub references come from
 * github.com URLs and `owner/repo#N` shorthand; Gitea references come only
 * from the origins configured via GITEA_URL / GITEA_PUBLIC_URL.
 */
export type PullRequestReference = GitHubPullRequestReference | GiteaPullRequestReference;

export type PullRequestMergeState = "merged" | "open" | "unknown";

export type PullRequestMergeDetails = {
  state: PullRequestMergeState;
  headRef: string | null;
  headSha: string | null;
};

export type PullRequestMergeStateResolver = (
  companyId: string,
  reference: PullRequestReference,
) => Promise<PullRequestMergeState>;

export type PullRequestMergeDetailsResolver = (
  companyId: string,
  reference: PullRequestReference,
) => Promise<PullRequestMergeDetails>;

/**
 * Stable identity for caches and dedup sets. The provider + host are part of
 * the key: `admin/tsa-monorepo#12` on Gitea and on GitHub are different PRs.
 */
export function pullRequestReferenceKey(reference: PullRequestReference) {
  return `${reference.provider}:${reference.host.toLowerCase()}`
    + `/${reference.owner.toLowerCase()}/${reference.repo.toLowerCase()}#${reference.number}`;
}

/** Human-readable label used in audit details. */
export function pullRequestReferenceLabel(reference: PullRequestReference) {
  const slug = `${reference.owner}/${reference.repo}#${reference.number}`;
  return reference.provider === "github" ? slug : `${reference.host}/${slug}`;
}

export const PULL_REQUEST_CACHE_MAX_ENTRIES = 1_000;

export function setBoundedPullRequestCacheEntry<T>(
  cache: Map<string, T>,
  key: string,
  value: T,
) {
  cache.delete(key);
  while (cache.size >= PULL_REQUEST_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
  cache.set(key, value);
}

const GITHUB_PULL_REQUEST_URL_PATTERN = /https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)/gi;
const GITHUB_PULL_REQUEST_SHORTHAND_PATTERN = /(^|[^A-Za-z0-9_.-])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)\b/g;

function addPullRequestReference(
  references: Map<string, GitHubPullRequestReference>,
  owner: string,
  repo: string,
  rawNumber: string,
) {
  const number = Number(rawNumber);
  if (!Number.isSafeInteger(number) || number <= 0) return;
  const reference = { provider: "github", host: "github.com", owner, repo, number } as const;
  const key = pullRequestReferenceKey(reference);
  if (!references.has(key)) references.set(key, reference);
}

export function extractGitHubPullRequestReferences(values: readonly unknown[]) {
  const references = new Map<string, GitHubPullRequestReference>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) continue;
    GITHUB_PULL_REQUEST_URL_PATTERN.lastIndex = 0;
    for (const match of value.matchAll(GITHUB_PULL_REQUEST_URL_PATTERN)) {
      addPullRequestReference(references, match[1]!, match[2]!, match[3]!);
    }
    GITHUB_PULL_REQUEST_SHORTHAND_PATTERN.lastIndex = 0;
    for (const match of value.matchAll(GITHUB_PULL_REQUEST_SHORTHAND_PATTERN)) {
      addPullRequestReference(references, match[2]!, match[3]!, match[4]!);
    }
  }
  return [...references.values()];
}

/**
 * Every PR reference this instance can resolve: GitHub (always) plus Gitea
 * (only for configured origins). Callers that must stay GitHub-only keep
 * using `extractGitHubPullRequestReferences`.
 */
export function extractPullRequestReferences(
  values: readonly unknown[],
  env?: GiteaEnv,
): PullRequestReference[] {
  return [
    ...extractGitHubPullRequestReferences(values),
    ...extractGiteaPullRequestReferences(values, env),
  ];
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function createPullRequestMergeDetailsResolver(db: Db): PullRequestMergeDetailsResolver {
  const resolver = createGitHubExternalObjectProvider(db).resolvers
    .find((candidate) => candidate.objectType === "pull_request") ?? null;
  const resolveGitea = createGiteaPullRequestMergeDetailsResolver(db);

  return async (companyId, reference) => {
    if (reference.provider === "gitea") return resolveGitea(companyId, reference);
    if (!resolver) return { state: "unknown", headRef: null, headSha: null };
    const result = await resolver.resolve({
      companyId,
      object: {
        externalId: `${reference.owner}/${reference.repo}#pull/${reference.number}`,
        sanitizedCanonicalUrl: `https://github.com/${reference.owner}/${reference.repo}/pull/${reference.number}`,
      } as never,
    });
    if (!result.ok) return { state: "unknown", headRef: null, headSha: null };
    const data = readRecord(result.snapshot.data);
    return {
      state: result.snapshot.statusKey === "merged" || data?.merged === true
        ? "merged"
        : "open",
      headRef: typeof data?.headRef === "string" ? data.headRef : null,
      headSha: typeof data?.headSha === "string" ? data.headSha : null,
    };
  };
}

export function createPullRequestMergeStateResolver(db: Db): PullRequestMergeStateResolver {
  const resolveDetails = createPullRequestMergeDetailsResolver(db);
  return async (companyId, reference) => (await resolveDetails(companyId, reference)).state;
}
