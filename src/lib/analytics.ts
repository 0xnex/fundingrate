export interface HourlyPrice {
  ticker: string;
  market: "perp" | "spot";
  bucket_start: string;
  close: number;
}

export interface FundingEvent {
  ticker: string;
  funding_time: string;
  funding_rate: number;
  rate_type: string;
}

export interface BasisPoint {
  time: number;
  perp: number;
  spot: number;
  basis: number;
}

export function alignHourlyPrices(prices: HourlyPrice[]): BasisPoint[] {
  const byHour = new Map<number, Partial<Record<"perp" | "spot", number>>>();
  for (const price of prices) {
    const time = Date.parse(price.bucket_start);
    if (!Number.isFinite(time) || !Number.isFinite(price.close) || price.close <= 0) continue;
    const pair = byHour.get(time) ?? {};
    pair[price.market] = price.close;
    byHour.set(time, pair);
  }
  return [...byHour]
    .filter((entry): entry is [number, { perp: number; spot: number }] =>
      entry[1].perp !== undefined && entry[1].spot !== undefined,
    )
    .sort((a, b) => a[0] - b[0])
    .map(([time, pair]) => ({
      time,
      perp: pair.perp,
      spot: pair.spot,
      basis: (pair.perp / pair.spot - 1) * 100,
    }));
}

export function fundingInWindow(events: FundingEvent[], startMs: number, endMs: number): FundingEvent[] {
  return events.filter((event) => {
    const time = Date.parse(event.funding_time);
    return time >= startMs && time < endMs && Number.isFinite(event.funding_rate);
  });
}

export function cumulativeFunding(events: FundingEvent[]): number {
  return events.reduce((sum, event) => sum + event.funding_rate * 100, 0);
}

export function annualizedFundingApy(events: FundingEvent[], days: number): number | null {
  if (!events.length || !Number.isFinite(days) || days <= 0) return null;
  const growth = events.reduce((value, event) => value * (1 + event.funding_rate), 1);
  if (growth <= 0 || !Number.isFinite(growth)) return null;
  return (Math.pow(growth, 365 / days) - 1) * 100;
}

export function normalizePrices(points: BasisPoint[]): { time: number; perp: number; spot: number }[] {
  const first = points[0];
  if (!first) return [];
  return points.map((point) => ({
    time: point.time,
    perp: (point.perp / first.perp - 1) * 100,
    spot: (point.spot / first.spot - 1) * 100,
  }));
}
