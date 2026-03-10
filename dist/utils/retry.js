const DEFAULT_MAX_DELAY_MS = 5_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const withRetry = async (operation, options) => {
    const { attempts, baseDelayMs, maxDelayMs = DEFAULT_MAX_DELAY_MS, shouldRetry, onRetry, } = options;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await operation();
        }
        catch (error) {
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
//# sourceMappingURL=retry.js.map