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

export interface ParsedOpenInterest {
  bucket_start: string;
  open_interest: number;
  open_interest_value: number;
}

export function parseOpenInterest(raw: unknown, nowHour: number): ParsedOpenInterest[] {
  if (!Array.isArray(raw)) throw new Error("Binance open interest response is not an array");
  return raw.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) throw new Error("Malformed Binance open interest");
    const row = entry as Record<string, unknown>;
    const timestamp = Number(row.timestamp);
    const openInterest = Number(row.sumOpenInterest);
    const value = Number(row.sumOpenInterestValue);
    if (!(Number.isFinite(timestamp) && timestamp > 0 && openInterest >= 0 && value >= 0 && Number.isFinite(openInterest) && Number.isFinite(value))) {
      throw new Error("Invalid Binance open interest value");
    }
    const bucket = Math.floor((timestamp - 1) / HOUR_MS) * HOUR_MS;
    if (bucket + HOUR_MS > nowHour) return [];
    return [{ bucket_start: new Date(bucket).toISOString(), open_interest: openInterest, open_interest_value: value }];
  });
}

export async function importOpenInterest(
  firstBucket: number,
  nowHour: number,
  fetchPage: (startTime: number, endTime: number) => Promise<unknown>,
  saveRows: (rows: ParsedOpenInterest[]) => Promise<void>,
): Promise<number> {
  // Binance timestamps each OI sample at the end of its hour and includes both
  // time bounds. Keep each requested range at 500 hourly samples at most.
  let cursor = firstBucket + HOUR_MS;
  let count = 0;
  while (cursor <= nowHour) {
    const pageEnd = Math.min(nowHour, cursor + 499 * HOUR_MS);
    const raw = await fetchPage(cursor, pageEnd);
    const rows = parseOpenInterest(raw, nowHour);
    if (rows.length) {
      await saveRows(rows);
      count += rows.length;
    }
    cursor = pageEnd + HOUR_MS;
  }
  return count;
}
