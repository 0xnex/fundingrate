import { DAY_MS, HOUR_MS, HISTORY_DAYS } from "./market";

export function completedHour(nowMs: number): number {
  return Math.floor(nowMs / HOUR_MS) * HOUR_MS;
}

export function incrementalStart(latestMs: number | null, nowHour: number, overlapMs: number): number {
  const cutoff = nowHour - HISTORY_DAYS * DAY_MS;
  return latestMs === null ? cutoff : Math.max(cutoff, latestMs - overlapMs);
}

export interface ParsedCandle {
  bucket_start: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function parseCompletedCandles(raw: unknown, nowHour: number): ParsedCandle[] {
  if (!Array.isArray(raw)) throw new Error("Binance candles response is not an array");
  return raw.flatMap((entry) => {
    if (!Array.isArray(entry) || entry.length < 6) throw new Error("Malformed Binance candle");
    const bucket = Number(entry[0]);
    const values = [entry[1], entry[2], entry[3], entry[4], entry[5]].map(Number);
    if (!Number.isInteger(bucket) || bucket % HOUR_MS !== 0 || values.some((value) => !Number.isFinite(value))) {
      throw new Error("Invalid Binance candle value");
    }
    if (bucket >= nowHour) return [];
    return [{
      bucket_start: new Date(bucket).toISOString(),
      open: values[0], high: values[1], low: values[2], close: values[3], volume: values[4],
    }];
  });
}

export interface ParsedFunding {
  funding_time: string;
  funding_rate: number;
  rate_type: string;
  mark_price: number | null;
}

export function parseFundingEvents(raw: unknown, nowMs: number): ParsedFunding[] {
  if (!Array.isArray(raw)) throw new Error("Binance funding response is not an array");
  return raw.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) throw new Error("Malformed Binance funding event");
    const value = entry as Record<string, unknown>;
    const time = Number(value.fundingTime);
    const rate = Number(value.fundingRate);
    const mark = value.markPrice == null ? null : Number(value.markPrice);
    if (!Number.isFinite(time) || !Number.isFinite(rate) || (mark !== null && !Number.isFinite(mark))) {
      throw new Error("Invalid Binance funding event value");
    }
    if (time > nowMs) return [];
    return [{
      funding_time: new Date(time).toISOString(),
      funding_rate: rate,
      rate_type: typeof value.rateType === "string" ? value.rateType : "Regular",
      mark_price: mark,
    }];
  });
}
