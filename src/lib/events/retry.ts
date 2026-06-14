import { logEventExecution } from "../observability/event-logger.js";
import { errorMessage } from "../../jobs/utils.js";

const TRANSIENT_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /network/i,
  /fetch failed/i,
  /econnreset/i,
  /econnrefused/i,
  /eai_again/i,
  /enotfound/i,
  /getaddrinfo/i,
  /503/,
  /502/,
  /504/,
  /429/,
  /rate limit/i
];

export function isTransientError(error: unknown) {
  const message = errorMessage(error);
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(message));
}

export async function withRetry<T>(
  label: string,
  fn: (attempt: number) => Promise<T>,
  options?: { maxAttempts?: number; baseDelayMs?: number; eventId?: string }
) {
  const maxAttempts = options?.maxAttempts ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 1_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const transient = isTransientError(error);
      logEventExecution({
        eventId: options?.eventId ?? label,
        phase: "retry",
        attemptCount: attempt,
        error: errorMessage(error),
        meta: { transient, maxAttempts }
      });

      if (!transient || attempt === maxAttempts) {
        throw error;
      }

      const delay = baseDelayMs * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
