import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
dayjs.extend(utc);
const FIVE_MINUTES_MS = 5 * 60_000;
export const toUtcMillis = (timestamp) => dayjs.utc(timestamp).valueOf();
export const minutesBeforeUtcMillis = (timestamp, minutes) => dayjs.utc(timestamp).subtract(minutes, "minute").valueOf();
export const formatIso = (timestamp) => dayjs.utc(timestamp).toISOString();
export const floorToFiveMinuteBucketUtc = (timestampMs) => Math.floor(timestampMs / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
export const isValidTimeRange = (start, end) => {
    const startMs = toUtcMillis(start);
    const endMs = toUtcMillis(end);
    return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
};
//# sourceMappingURL=time.js.map