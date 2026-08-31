import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const stubNodeHandler = vi.fn((_req: unknown, _res: unknown) => Promise.resolve());

vi.mock("@paperclipai/db", () => ({
  invites: {
    revokedAt: { name: "revokedAt" },
    expiresAt: { name: "expiresAt" },
    tokenHash: { name: "tokenHash" },
  },
  authAccounts: {},
  authSessions: {},
  authUsers: {},
  authVerifications: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: (_column: unknown, value: string) => ({ kind: "eq", value }),
}));

vi.mock("better-auth", () => ({ betterAuth: vi.fn(() => ({})) }));
vi.mock("better-auth/adapters/drizzle", () => ({ drizzleAdapter: vi.fn() }));
vi.mock("better-auth/node", () => ({ toNodeHandler: vi.fn(() => stubNodeHandler) }));

import {
  createBetterAuthHandler,
  isValidInviteSignupToken,
} from "../auth/better-auth.js";

function hash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

type InviteRow = { revokedAt: Date | null; expiresAt: Date };

function fakeDb(inviteByTokenHash: Record<string, InviteRow | undefined>) {
  return {
    select: () => ({
      from: () => ({
        where: (condition: { kind: string; value: string }) => ({
          then: (resolve: (rows: unknown[]) => unknown) =>
            Promise.resolve(
              inviteByTokenHash[condition.value]
                ? [inviteByTokenHash[condition.value]]
                : [],
            ).then(resolve),
        }),
      }),
    }),
  };
}

function futureDate(seconds: number) {
  return new Date(Date.now() + seconds * 1000);
}

function makeReqRes(path: string, cookie?: string) {
  const req = {
    method: "POST",
    path,
    headers: cookie ? { cookie } : {},
  } as unknown as import("express").Request;
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const res = { status, json } as unknown as import("express").Response;
  return { req, res, json, status };
}

beforeEach(() => {
  stubNodeHandler.mockClear();
});

describe("isValidInviteSignupToken", () => {
  it("allows a live, unrevoked invite", async () => {
    const token = "pcp_invite_live";
    const db = fakeDb({ [hash(token)]: { revokedAt: null, expiresAt: futureDate(3600) } });
    await expect(isValidInviteSignupToken(db as never, token)).resolves.toBe(true);
  });

  it("rejects revoked invites", async () => {
    const token = "pcp_invite_revoked";
    const db = fakeDb({ [hash(token)]: { revokedAt: new Date(), expiresAt: futureDate(3600) } });
    await expect(isValidInviteSignupToken(db as never, token)).resolves.toBe(false);
  });

  it("rejects expired invites", async () => {
    const token = "pcp_invite_expired";
    const db = fakeDb({ [hash(token)]: { revokedAt: null, expiresAt: new Date(Date.now() - 1000) } });
    await expect(isValidInviteSignupToken(db as never, token)).resolves.toBe(false);
  });

  it("rejects unknown tokens and empty input", async () => {
    const db = fakeDb({});
    await expect(isValidInviteSignupToken(db as never, "pcp_invite_unknown")).resolves.toBe(false);
    await expect(isValidInviteSignupToken(db as never, "  ")).resolves.toBe(false);
  });
});

describe("createBetterAuthHandler invite-gated sign-up", () => {
  const token = "pcp_invite_live";
  const guard = {
    config: { authDisableSignUp: true },
    db: fakeDb({ [hash(token)]: { revokedAt: null, expiresAt: futureDate(3600) } }) as never,
  };
  const auth = {} as never;
  const next = vi.fn();

  it("blocks sign-up without an invite cookie", async () => {
    const { req, res, json, status } = makeReqRes("/api/auth/sign-up/email");
    createBetterAuthHandler(auth, guard)(req, res, next);
    await vi.waitFor(() => expect(status).toHaveBeenCalledWith(400));
    expect(json).toHaveBeenCalledWith({
      code: "EMAIL_PASSWORD_SIGN_UP_DISABLED",
      message: "Email and password sign up is not enabled",
    });
    expect(stubNodeHandler).not.toHaveBeenCalled();
  });

  it("blocks sign-up when the cookie carries an invalid token", async () => {
    const { req, res, status } = makeReqRes(
      "/api/auth/sign-up/email",
      "pcp_invite_signup=pcp_invite_unknown",
    );
    createBetterAuthHandler(auth, guard)(req, res, next);
    await vi.waitFor(() => expect(status).toHaveBeenCalledWith(400));
    expect(stubNodeHandler).not.toHaveBeenCalled();
  });

  it("passes sign-up through with a valid invite cookie", async () => {
    const { req, res } = makeReqRes(
      "/api/auth/sign-up/email",
      `pcp_invite_signup=${encodeURIComponent(token)}`,
    );
    createBetterAuthHandler(auth, guard)(req, res, next);
    await vi.waitFor(() => expect(stubNodeHandler).toHaveBeenCalledWith(req, res));
  });

  it("does not guard other auth paths", async () => {
    const { req, res } = makeReqRes("/api/auth/sign-in/email");
    createBetterAuthHandler(auth, guard)(req, res, next);
    await vi.waitFor(() => expect(stubNodeHandler).toHaveBeenCalledWith(req, res));
  });

  it("does not guard when public sign-up is enabled", async () => {
    const openGuard = {
      config: { authDisableSignUp: false },
      db: fakeDb({}) as never,
    };
    const { req, res } = makeReqRes("/api/auth/sign-up/email");
    createBetterAuthHandler(auth, openGuard)(req, res, next);
    await vi.waitFor(() => expect(stubNodeHandler).toHaveBeenCalledWith(req, res));
  });
});