import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  companySecrets,
  createDb,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { HttpError } from "../errors.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping secrets provider write timeout tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// TSA-1321 repro, mocked: a secret provider whose write never settles used
// to hold the per-company account-home mutation lock forever, so the create
// request hung (>90s, curl -m 30 gave up) and every later secret write for
// the same company queued behind it. These tests prove the provider write
// is raced against a bound: the hung create fails closed with a
// `provider_timeout` client error, the reserved row is rolled back, and the
// queued follow-up create gets the lock and succeeds.
const TEST_WRITE_TIMEOUT_MS = 400;
// Generous ceiling for "the create failed within the bound". Without the
// fix the create never settles, so this race is what turns a hang into a
// fast, legible test failure instead of a suite timeout.
const BOUNDED_FAILURE_CEILING_MS = 8_000;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describeEmbeddedPostgres("secretService provider write timeout", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const previousWriteTimeout = process.env.PAPERCLIP_SECRETS_PROVIDER_WRITE_TIMEOUT_MS;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-secrets-provider-timeout-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    process.env.PAPERCLIP_SECRETS_PROVIDER_WRITE_TIMEOUT_MS = String(TEST_WRITE_TIMEOUT_MS);
    const started = await startEmbeddedPostgresTestDatabase("secrets-provider-timeout");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(companySecrets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    if (previousWriteTimeout === undefined) {
      delete process.env.PAPERCLIP_SECRETS_PROVIDER_WRITE_TIMEOUT_MS;
    } else {
      process.env.PAPERCLIP_SECRETS_PROVIDER_WRITE_TIMEOUT_MS = previousWriteTimeout;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany(name = "Acme") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  it("fails a hanging provider write with a bounded provider_timeout error, rolls back the reserved row, and lets a queued create in the same company succeed", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const originalCreateSecret = localEncryptedProvider.createSecret.bind(localEncryptedProvider);
    const createSecretSpy = vi.spyOn(localEncryptedProvider, "createSecret");

    // First call: the provider write never settles — the mocked hang that
    // reproduced the incident. Second call: the real provider writes.
    const hungWrite = deferred<never>();
    createSecretSpy
      .mockImplementationOnce(() => hungWrite.promise as never)
      .mockImplementationOnce((input: { value: string }) => originalCreateSecret(input));

    const hungName = `hung-${randomUUID()}`;
    const hungCreate = svc.create(companyId, {
      name: hungName,
      provider: "local_encrypted",
      value: "synthetic-not-a-real-secret",
    });

    // Give the hung create a moment to reach (and wedge inside) its
    // provider write, then start the queued create for the same company.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const queuedName = `queued-${randomUUID()}`;
    const queuedCreate = svc.create(companyId, {
      name: queuedName,
      provider: "local_encrypted",
      value: "synthetic-queued-not-a-real-secret",
    });

    // The hung create must fail within the bound — never hang.
    const startedAt = Date.now();
    const boundedHungCreate = Promise.race([
      hungCreate,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`hung create did not fail within ${BOUNDED_FAILURE_CEILING_MS}ms — provider write hung`)),
          BOUNDED_FAILURE_CEILING_MS,
        ),
      ),
    ]);
    const hungError = await boundedHungCreate.then(
      () => { throw new Error("hung create unexpectedly succeeded"); },
      (error: unknown) => error,
    );
    expect(Date.now() - startedAt).toBeLessThan(BOUNDED_FAILURE_CEILING_MS);
    // The service converts provider client errors to HttpError for the HTTP
    // layer (remoteProviderHttpError), preserving the 504 status and the
    // provider error code in details.
    expect(hungError).toBeInstanceOf(HttpError);
    const httpError = hungError as HttpError;
    expect(httpError.status).toBe(504);
    expect(httpError.details).toMatchObject({ code: "provider_timeout" });
    // Redaction boundary: the error message must not echo the secret value.
    expect(httpError.message).not.toContain("synthetic-not-a-real-secret");

    // The reserved row for the hung create is rolled back, not left behind.
    const rowsForCompany = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.companyId, companyId));
    expect(rowsForCompany.map((row) => row.name)).toEqual([]);

    // The queued create acquires the freed lock and succeeds — proof the
    // timeout released the per-company mutation lock, the exact wedge from
    // the incident.
    const queuedSecret = await Promise.race([
      queuedCreate,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`queued create did not succeed within ${BOUNDED_FAILURE_CEILING_MS}ms — lock still held`)),
          BOUNDED_FAILURE_CEILING_MS,
        ),
      ),
    ]);
    expect(queuedSecret.name).toBe(queuedName);
    expect(queuedSecret.status).toBe("active");

    const finalRows = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.companyId, companyId));
    expect(finalRows.map((row) => row.name).sort()).toEqual([queuedName]);

    // A timed-out write that settles late must not surface as an unhandled
    // rejection after the caller already failed.
    const lateSettlementObserved = hungWrite.promise.catch(() => undefined);
    hungWrite.reject(new Error("late provider failure after timeout"));
    await lateSettlementObserved;
  });

  it("leaves successful provider writes untouched when they finish inside the bound", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const created = await svc.create(companyId, {
      name: `fast-${randomUUID()}`,
      provider: "local_encrypted",
      value: "synthetic-fast",
    });
    expect(created.status).toBe("active");
    expect(created.provider).toBe("local_encrypted");
  });
});
