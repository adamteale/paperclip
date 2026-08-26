import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { secretService } from "./secrets.js";
import type { PullRequestMergeDetails } from "./github-pull-request-merge.js";

/**
 * Gitea/Forgejo support for the merged-pull-request confirmation sweep.
 *
 * The sweep (see `sweepMergedPullRequestConfirmations` in
 * issue-thread-interactions.ts) was GitHub-only, so self-hosted Gitea
 * instances (ASUS/TSA) never had a merged PR reach Paperclip and their cases
 * had to be advanced by hand.
 *
 * Two deliberate constraints:
 *  - Hosts are NOT inferred from the URL. Only origins configured through
 *    `GITEA_URL` / `GITEA_PUBLIC_URL` are recognised, so an arbitrary
 *    attacker-controlled host that happens to serve `/owner/repo/pulls/N`
 *    can never be used to auto-accept a human approval gate.
 *  - Anything other than a confirmed `merged: true` resolves to "open" or
 *    "unknown"; neither state accepts an interaction (fail-closed).
 */

/** Company-secret names probed for a Gitea API token, in priority order. */
export const DEFAULT_GITEA_TOKEN_SECRET_NAMES = ["GITEA_TOKEN", "GITEA_ADMIN_TOKEN"] as const;

/** Env vars probed for a Gitea API token when no company secret matches. */
export const DEFAULT_GITEA_TOKEN_ENV_KEYS = ["GITEA_ADMIN_TOKEN", "GITEA_TOKEN"] as const;

/** Env vars that declare which Gitea origins Paperclip trusts. */
export const GITEA_ORIGIN_ENV_KEYS = ["GITEA_URL", "GITEA_PUBLIC_URL"] as const;

const GITEA_REQUEST_TIMEOUT_MS = 10_000;

export type GiteaPullRequestReference = {
  provider: "gitea";
  /** Authority (`host[:port]`) of the configured origin this reference matched. */
  host: string;
  /** Configured origin (scheme + authority + optional base path), no trailing slash. */
  baseUrl: string;
  owner: string;
  repo: string;
  number: number;
};

export type GiteaEnv = Record<string, string | undefined>;

function normalizeOrigin(raw: string): { baseUrl: string; host: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const path = parsed.pathname.replace(/\/+$/, "");
  return { baseUrl: `${parsed.origin}${path}`, host: parsed.host };
}

/**
 * The Gitea origins this instance trusts, derived from configuration only.
 * Both the internal (`GITEA_URL`, e.g. http://192.168.100.92:3002) and the
 * public (`GITEA_PUBLIC_URL`, e.g. https://robotpants.ddns.net:9443) origin
 * must match, because agents post either form depending on the tool that
 * created the PR. Each var may hold a comma-separated list.
 */
export function getConfiguredGiteaOrigins(env: GiteaEnv = process.env): Array<{ baseUrl: string; host: string }> {
  const seen = new Set<string>();
  const origins: Array<{ baseUrl: string; host: string }> = [];
  for (const key of GITEA_ORIGIN_ENV_KEYS) {
    for (const candidate of (env[key] ?? "").split(",")) {
      const normalized = normalizeOrigin(candidate);
      if (!normalized) continue;
      const dedupeKey = normalized.baseUrl.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      origins.push(normalized);
    }
  }
  return origins;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the Gitea PR-URL matcher for the configured origins, or null when no
 * Gitea origin is configured (GitHub-only instances match nothing here).
 *
 * Note `pulls` (plural) — Gitea's PR path differs from GitHub's `pull`.
 * Group 1 is the leading boundary (kept so replacements can restore it),
 * group 2 the origin, groups 3/4/5 owner/repo/number. The leading boundary
 * stops `https://evil.example/https://gitea.internal/o/r/pulls/1` from being
 * read as a trusted-origin URL.
 */
export function buildGiteaPullRequestUrlPattern(env: GiteaEnv = process.env): RegExp | null {
  const origins = getConfiguredGiteaOrigins(env);
  if (origins.length === 0) return null;
  const alternation = origins.map((origin) => escapeRegExp(origin.baseUrl)).join("|");
  return new RegExp(
    `(^|[\\s<>"'\`([{,;])(${alternation})\\/([A-Za-z0-9_.-]+)\\/([A-Za-z0-9_.-]+)\\/pulls\\/([1-9][0-9]*)\\b`,
    "gi",
  );
}

export function extractGiteaPullRequestReferences(
  values: readonly unknown[],
  env: GiteaEnv = process.env,
): GiteaPullRequestReference[] {
  const pattern = buildGiteaPullRequestUrlPattern(env);
  if (!pattern) return [];
  const origins = getConfiguredGiteaOrigins(env);
  const references = new Map<string, GiteaPullRequestReference>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) continue;
    pattern.lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
      const matchedOrigin = match[2]!;
      const owner = match[3]!;
      const repo = match[4]!;
      const number = Number(match[5]!);
      if (!Number.isSafeInteger(number) || number <= 0) continue;
      // Resolve back to the configured (canonically-cased) origin so the API
      // call always uses configuration, never text from the interaction.
      const origin = origins.find((candidate) => candidate.baseUrl.toLowerCase() === matchedOrigin.toLowerCase());
      if (!origin) continue;
      const key = `${origin.baseUrl.toLowerCase()}/${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
      if (references.has(key)) continue;
      references.set(key, {
        provider: "gitea",
        host: origin.host,
        baseUrl: origin.baseUrl,
        owner,
        repo,
        number,
      });
    }
  }
  return [...references.values()];
}

export type GiteaPullRequestFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type GiteaPullRequestMergeResolverOptions = {
  fetch?: GiteaPullRequestFetch;
  /** Overrides secret + env probing (used by tests). */
  tokenProvider?: (companyId: string) => Promise<string | null> | string | null;
  secretNames?: readonly string[];
  env?: GiteaEnv;
  timeoutMs?: number;
};

async function defaultGiteaTokenProvider(
  db: Db,
  companyId: string,
  secretNames: readonly string[],
  env: GiteaEnv,
): Promise<string | null> {
  const secrets = secretService(db);
  for (const secretName of secretNames) {
    const secret = await Promise.resolve(secrets.getByName(companyId, secretName)).catch(() => null);
    if (!secret) continue;
    const token = await secrets
      .resolveSecretValue(companyId, secret.id, "latest")
      .catch(() => null);
    const trimmed = token?.trim();
    if (trimmed) return trimmed;
  }
  // Server-level fallback: ASUS keeps the Gitea admin token in
  // /etc/paperclip/env, which the systemd unit sources into the process env.
  for (const envKey of DEFAULT_GITEA_TOKEN_ENV_KEYS) {
    const trimmed = env[envKey]?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const UNKNOWN_DETAILS: PullRequestMergeDetails = { state: "unknown", headRef: null, headSha: null };

/**
 * Every path to "unknown" is a SILENT failure with real consequences: the
 * sweep simply leaves the confirmation pending, which on an instance without
 * branch protection (TSA) means merged PRs stop advancing their cases and
 * nothing anywhere says why. A TLS error against the public origin, an expired
 * token, or a renamed repo all look identical to "not merged yet" unless we
 * say so. Warn level, with the host and reason named, so the failure is one
 * grep away instead of invisible.
 *
 * Volume is bounded by the number of pending merge confirmations per sweep
 * (single digits in practice), so this deliberately has no dedupe machinery.
 */
function warnGiteaResolveFailed(
  reason: string,
  reference: GiteaPullRequestReference,
  details: Record<string, unknown> = {},
) {
  logger.warn({
    reason,
    host: reference.host,
    repo: `${reference.owner}/${reference.repo}`,
    pullRequestNumber: reference.number,
    ...details,
  }, "gitea pull-request merge state unresolved; confirmation left pending");
}

/**
 * Resolve a Gitea PR's merge state via `GET /api/v1/repos/{owner}/{repo}/pulls/{n}`.
 * Gitea 1.27 returns `merged` (bool) and `state` ("open" | "closed"); there is
 * no `mergeable_state` field. Auth reuses the same credential the rest of the
 * platform uses for Gitea — company secret `GITEA_TOKEN`/`GITEA_ADMIN_TOKEN`
 * first, then the `GITEA_ADMIN_TOKEN`/`GITEA_TOKEN` process env — sent as
 * Gitea's `Authorization: token <value>` header.
 */
export function createGiteaPullRequestMergeDetailsResolver(
  db: Db,
  opts: GiteaPullRequestMergeResolverOptions = {},
) {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const secretNames = opts.secretNames ?? DEFAULT_GITEA_TOKEN_SECRET_NAMES;
  const tokenProvider = opts.tokenProvider
    ?? ((companyId: string) => defaultGiteaTokenProvider(db, companyId, secretNames, env));

  return async (
    companyId: string,
    reference: GiteaPullRequestReference,
  ): Promise<PullRequestMergeDetails> => {
    // Re-verify the origin against configuration at call time: a reference
    // must never send credentials to a host that is no longer trusted.
    const origins = getConfiguredGiteaOrigins(env);
    const origin = origins.find((candidate) => candidate.baseUrl.toLowerCase() === reference.baseUrl.toLowerCase());
    if (!origin) {
      warnGiteaResolveFailed("origin_not_configured", reference, {
        baseUrl: reference.baseUrl,
        configuredOrigins: origins.map((candidate) => candidate.baseUrl),
        hint: "set GITEA_URL / GITEA_PUBLIC_URL to the origins agents post PR links from",
      });
      return UNKNOWN_DETAILS;
    }

    let token: string | null = null;
    try {
      token = (await tokenProvider(companyId))?.trim() || null;
    } catch (err) {
      warnGiteaResolveFailed("token_unresolvable", reference, { err, companyId });
      return UNKNOWN_DETAILS;
    }

    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": "paperclip-pull-request-merge-resolver",
    };
    if (token) headers.authorization = `token ${token}`;

    const url = `${origin.baseUrl}/api/v1/repos/${encodeURIComponent(reference.owner)}`
      + `/${encodeURIComponent(reference.repo)}/pulls/${reference.number}`;

    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? GITEA_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // The TLS case lands here: a self-signed or otherwise untrusted cert on
      // the public origin (https://robotpants.ddns.net:9443) throws before any
      // response, and would otherwise be indistinguishable from "not merged".
      warnGiteaResolveFailed("request_failed", reference, {
        err,
        url,
        hasToken: Boolean(token),
        hint: "check TLS trust, DNS and network reachability from the Paperclip host to this origin",
      });
      return UNKNOWN_DETAILS;
    }
    if (!response.ok) {
      warnGiteaResolveFailed("http_error", reference, {
        status: response.status,
        url,
        hasToken: Boolean(token),
        hint: response.status === 401 || response.status === 403
          ? "Gitea rejected the credential — check the GITEA_TOKEN / GITEA_ADMIN_TOKEN company secret or env var"
          : response.status === 404
            ? "repo or PR not found for this token's visibility — check owner/repo and token scope"
            : undefined,
      });
      return UNKNOWN_DETAILS;
    }

    let body: Record<string, unknown> | null;
    try {
      body = readRecord(await response.json());
    } catch (err) {
      warnGiteaResolveFailed("invalid_json", reference, { err, url });
      return UNKNOWN_DETAILS;
    }
    if (!body) {
      warnGiteaResolveFailed("unexpected_body", reference, { url });
      return UNKNOWN_DETAILS;
    }

    const head = readRecord(body.head);
    return {
      // Only an explicit `merged: true` counts. A closed-but-not-merged PR is
      // reported as "open" so the sweep leaves the confirmation pending.
      state: body.merged === true ? "merged" : "open",
      headRef: typeof head?.ref === "string" ? head.ref : null,
      headSha: typeof head?.sha === "string" ? head.sha : null,
    };
  };
}
