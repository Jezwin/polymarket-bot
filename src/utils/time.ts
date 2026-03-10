import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";

dayjs.extend(utc);

const FIVE_MINUTES_MS = 5 * 60_000;

export const toUtcMillis = (timestamp: string): number => dayjs.utc(timestamp).valueOf();

export const minutesBeforeUtcMillis = (timestamp: string, minutes: number): number =>
  dayjs.utc(timestamp).subtract(minutes, "minute").valueOf();

export const formatIso = (timestamp: string | number): string => dayjs.utc(timestamp).toISOString();

export const floorToFiveMinuteBucketUtc = (timestampMs: number): number =>
  Math.floor(timestampMs / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;

export const isValidTimeRange = (start: string, end: string): boolean => {
  const startMs = toUtcMillis(start);
  const endMs = toUtcMillis(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
};
