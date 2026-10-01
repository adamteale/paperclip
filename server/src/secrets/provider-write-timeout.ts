import type { SecretProvider } from "@paperclipai/shared";
import { SecretProviderClientError } from "./types.js";

// TSA-1321: a secret provider write that never settles (unreachable remote
// vault, hung AWS credential-chain lookup, wedged provider of any kind) used
// to hold the per-company account-home mutation lock forever, because
// `create`/`rotate` run their provider write inside
// `withAccountHomeSecretMutationLock`. The hung request never failed, every
// later secret write for the same company queued behind it, and the API
// piled up. Every provider I/O method handed out by the provider registry is
// raced against this bound, so a wedged provider write fails closed instead.
//
// The default exceeds the AWS provider's own 30s HTTP timeout
// (`AWS_SECRETS_MANAGER_REQUEST_TIMEOUT_MS`) on purpose: an inner timeout
// that fires first surfaces its precise provider error, and this outer bound
// only catches work with no inner bound at all (credential resolution,
// providers without their own timeout, future providers).
export const DEFAULT_SECRET_PROVIDER_WRITE_TIMEOUT_MS = 45_000;
export const SECRET_PROVIDER_WRITE_TIMEOUT_ENV = "PAPERCLIP_SECRETS_PROVIDER_WRITE_TIMEOUT_MS";

export function resolveSecretProviderWriteTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SECRET_PROVIDER_WRITE_TIMEOUT_ENV]?.trim();
  if (!raw) return DEFAULT_SECRET_PROVIDER_WRITE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 100) {
    throw new Error(
      `${SECRET_PROVIDER_WRITE_TIMEOUT_ENV} must be a number of milliseconds >= 100, got: ${raw}`,
    );
  }
  return parsed;
}

/**
 * Races a provider I/O operation against a wall-clock bound. On timeout the
 * caller gets a `provider_timeout` `SecretProviderClientError` (HTTP 504);
 * the losing operation keeps running in the background (provider interfaces
 * take no AbortSignal), but its late settlement is observed here so it can
 * never surface as an unhandled rejection.
 */
export function withSecretProviderIoTimeout<T>(input: {
  provider: SecretProvider;
  operation: string;
  run: () => Promise<T>;
}): Promise<T> {
  const timeoutMs = resolveSecretProviderWriteTimeoutMs();
  const work = input.run();
  // The race below abandons `work` on timeout, but Node still tracks its
  // eventual settlement; observe it here so a late failure after the caller
  // already moved on never becomes an unhandled rejection.
  work.catch(() => undefined);
  const timedOut = Symbol("timedOut");
  const timeout = new Promise<typeof timedOut>((resolve) => {
    const timer = setTimeout(() => resolve(timedOut), timeoutMs);
    // Never hold the process open just for this bound; the losing work is
    // fire-and-forget by design.
    timer.unref?.();
  });
  return Promise.race([work, timeout]).then((result) => {
    if (result === timedOut) {
      throw new SecretProviderClientError({
        code: "provider_timeout",
        provider: input.provider,
        operation: input.operation,
        // No value, key, or ref material in the message — keep the redaction
        // boundary closed (TSA-1321 constraint).
        message: `Secret provider '${input.provider}' operation '${input.operation}' timed out after ${timeoutMs}ms`,
      });
    }
    return result;
  });
}
