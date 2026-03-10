export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  label?: string;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown, nextDelayMs: number) => void;
}

const DEFAULT_MAX_DELAY_MS = 5_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const withRetry = async <T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> => {
  const {
    attempts,
    baseDelayMs,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    shouldRetry,
    onRetry,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const canRetry = attempt < attempts && (shouldRetry ? shouldRetry(error) : true);

      if (!canRetry) {
        throw error;
      }

      const exponential = baseDelayMs * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * 100);
      const delayMs = Math.min(maxDelayMs, exponential + jitter);

      onRetry?.(attempt, error, delayMs);
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Retry failed");
};
