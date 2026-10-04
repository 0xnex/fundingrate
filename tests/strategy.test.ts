import { describe, expect, test } from "bun:test";
import { importOpenInterest, parseOpenInterest } from "../src/lib/sync-logic";
import { assessEntryDepth, DEFAULT_STRATEGY_INPUTS, estimateHistoricalPreview, fillBook, simulateOpportunity, summarizeFunding, type MarketSnapshot } from "../src/lib/strategy";
import type { FundingEvent } from "../src/lib/analytics";
import { DAY_MS, HOUR_MS } from "../src/lib/market";

const now = Date.parse("2026-09-29T12:00:00.000Z");
const through = now - HOUR_MS;
const events: FundingEvent[] = Array.from({ length: 30 }, (_, index) => ({
  ticker: "TSLA", funding_time: new Date(through - (29 - index) * DAY_MS - HOUR_MS).toISOString(),
  funding_rate: 0.001, rate_type: "Regular",
}));
const snapshot: MarketSnapshot = {
  ticker: "TSLA", fetchedAt: new Date(now).toISOString(), quoteTime: now,
  fundingRate: 0.001, nextFundingTime: now + 4 * HOUR_MS,
  markPrice: 101.5, openInterest: 1000, openInterestTime: now,
  spotBook: { fetchedAt: new Date(now).toISOString(), bids: [[99, 20]], asks: [[100, 20]] },
  perpBook: { fetchedAt: new Date(now).toISOString(), bids: [[101, 20]], asks: [[102, 20]] },
};

describe("strategy metrics", () => {
  test("starts the simulator at $100,000 for 90 days", () => {
    expect(DEFAULT_STRATEGY_INPUTS.budget).toBe(100_000);
    expect(DEFAULT_STRATEGY_INPUTS.days).toBe(90);
  });

  test("separates regular funding from special events and preserves short-side signs", () => {
    const mixed = [
      ...events,
      { ...events[0], funding_rate: -0.005, rate_type: "Special" },
      { ...events[1], funding_rate: -0.002 },
    ];
    const result = summarizeFunding(mixed, through, 30);
    expect(result.regularCount).toBe(31);
    expect(result.specialCount).toBe(1);
    expect(result.totalSum).toBeCloseTo(result.regularSum - 0.005);
    expect(result.negativeShare).toBeCloseTo(1 / 31);
    expect(result.dailyRate).toBeGreaterThan(0);
  });

  test("walks both sides of a book and rejects an unfillable order", () => {
    expect(fillBook([[100, 1], [101, 2]], 2)?.vwap).toBeCloseTo(100.5);
    expect(fillBook([[100, 1]], 2)).toBeNull();
  });

  test("checks matched entry quantity across spot asks and perp bids at the requested size", () => {
    const spot = { fetchedAt: new Date(now).toISOString(), bids: [[99, 3]] as [number, number][], asks: [[100, 1], [101, 2]] as [number, number][] };
    const perp = { fetchedAt: new Date(now).toISOString(), bids: [[102, 1], [101, 1]] as [number, number][], asks: [[103, 2]] as [number, number][] };
    const depth = assessEntryDepth(spot, perp, 200);
    expect(depth?.quantity).toBe(2);
    expect(depth?.spotFill?.vwap).toBeCloseTo(100.5);
    expect(depth?.perpFill?.vwap).toBeCloseTo(101.5);
    expect(depth?.pairedDepthUsdt).toBe(200);
    expect(depth?.bands[0].pairedUsdt).toBe(100);
    expect(assessEntryDepth(spot, perp, 300)?.perpFill).toBeNull();
  });

  test("budgets spot, margin, reserve, all four fees, and applies basis scenarios", () => {
    const result = simulateOpportunity(snapshot, events, through, DEFAULT_STRATEGY_INPUTS, now);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.spotCash + result.initialMargin + result.reserve + result.totalFees).toBeLessThanOrEqual(DEFAULT_STRATEGY_INPUTS.budget + 1e-6);
    expect(result.adverseMoveBufferPct).toBeGreaterThanOrEqual(30 - 1e-6);
    expect(result.totalFees).toBeCloseTo((result.spotCash + result.quantity * 99) * 0.001 + (result.quantity * 101 + result.quantity * 102) * 0.0005);
    expect(result.entrySpotPrice).toBeCloseTo(result.spotCash / result.quantity);
    expect(result.entryPerpPrice).toBeCloseTo(101);
    expect(result.netProfit).toBeCloseTo(result.projectedFunding - result.totalFees - result.executionCost - result.carryingCost);
    expect(result.widerBasisProfit).toBeLessThan(result.netProfit);
    expect(result.zeroBasisProfit).toBeGreaterThan(result.netProfit);
    const withSpecial = simulateOpportunity(snapshot, [...events, { ...events[0], rate_type: "Special", funding_rate: 0.2 }], through, DEFAULT_STRATEGY_INPUTS, now);
    expect(withSpecial?.projectedFunding).toBeCloseTo(result.projectedFunding);
  });

  test("does not invent a recommendation for stale quotes, absent spot depth, or insufficient book depth", () => {
    expect(simulateOpportunity({ ...snapshot, fetchedAt: new Date(now - 61_000).toISOString() }, events, through, DEFAULT_STRATEGY_INPUTS, now)).toBeNull();
    expect(simulateOpportunity({ ...snapshot, quoteTime: now - 61_000 }, events, through, DEFAULT_STRATEGY_INPUTS, now)).toBeNull();
    expect(simulateOpportunity({ ...snapshot, spotBook: null }, events, through, DEFAULT_STRATEGY_INPUTS, now)).toBeNull();
    expect(simulateOpportunity({ ...snapshot, spotBook: { ...snapshot.spotBook!, asks: [] } }, events, through, DEFAULT_STRATEGY_INPUTS, now)).toBeNull();
  });

  test("stops sizing before costly deeper book levels", () => {
    const thinSpot = { ...snapshot, spotBook: { ...snapshot.spotBook!, bids: [[100, 11]] as [number, number][], asks: [[100, 1], [120, 10]] as [number, number][] } };
    const result = simulateOpportunity(thinSpot, events, through, { ...DEFAULT_STRATEGY_INPUTS, budget: 2000, days: 30 }, now);
    expect(result).not.toBeNull();
    expect(result?.quantity).toBeCloseTo(1);
    expect(result?.netProfit).toBeGreaterThan(0);
    expect(result?.entrySpotPrice).toBeCloseTo(100);
  });

  test("historical-only estimate responds to budget and holding days without order books", () => {
    const dailyRate = 0.000049;
    const inputs = { ...DEFAULT_STRATEGY_INPUTS, budget: 1000, days: 30 };
    const base = estimateHistoricalPreview(inputs, dailyRate);
    const twice = estimateHistoricalPreview({ ...inputs, budget: 2000 }, dailyRate);
    const longer = estimateHistoricalPreview({ ...inputs, days: 90 }, dailyRate);
    expect(base).not.toBeNull();
    expect(twice?.notional).toBeCloseTo(base!.notional * 2);
    expect(twice?.netBeforeExecution).toBeCloseTo(base!.netBeforeExecution * 2);
    expect(longer?.grossFunding).toBeGreaterThan(base!.grossFunding);
    expect(base!.netBeforeExecution).toBeLessThan(0);
    expect(longer!.netBeforeExecution).toBeGreaterThan(0);
    expect(base!.spotCash + base!.initialMargin + base!.reserve + base!.fees).toBeLessThanOrEqual(inputs.budget + 1e-6);
    expect(base!.adverseMoveBufferPct).toBeGreaterThanOrEqual(DEFAULT_STRATEGY_INPUTS.shockPct - 1e-6);
  });
});

test("open interest parser aligns completed hourly buckets and accepts idempotent overlaps", () => {
  const raw = [{ timestamp: now, sumOpenInterest: "100", sumOpenInterestValue: "10150" }, { timestamp: now + HOUR_MS, sumOpenInterest: "110", sumOpenInterestValue: "11165" }];
  expect(parseOpenInterest(raw, now)).toEqual([{ bucket_start: new Date(now - HOUR_MS).toISOString(), open_interest: 100, open_interest_value: 10150 }]);
  expect(parseOpenInterest(raw, now + HOUR_MS)).toHaveLength(2);
});

test("open interest import traverses a 30-day inclusive endpoint without repeating or skipping hours", async () => {
  const firstBucket = now - 720 * HOUR_MS;
  const source = Array.from({ length: 720 }, (_, index) => ({
    timestamp: firstBucket + (index + 1) * HOUR_MS,
    sumOpenInterest: "100", sumOpenInterestValue: "10150",
  }));
  const requests: [number, number][] = [];
  const imported: string[] = [];
  const stored = new Set(source.slice(-500).map((row) => new Date(row.timestamp - HOUR_MS).toISOString()));
  const count = await importOpenInterest(firstBucket, now, async (start, end) => {
    requests.push([start, end]);
    // Binance rounds an inclusive startTime down to the period boundary.
    const roundedStart = Math.floor(start / HOUR_MS) * HOUR_MS;
    return source.filter((row) => row.timestamp >= roundedStart && row.timestamp <= end).slice(-500);
  }, async (rows) => {
    imported.push(...rows.map((row) => row.bucket_start));
    for (const row of rows) stored.add(row.bucket_start);
  });
  expect(count).toBe(720);
  expect(new Set(imported).size).toBe(720);
  expect(stored.size).toBe(720);
  expect(imported[0]).toBe(new Date(firstBucket).toISOString());
  expect(imported.at(-1)).toBe(new Date(now - HOUR_MS).toISOString());
  expect(requests.length).toBeGreaterThan(1);
  expect(requests.every(([start, end]) => end - start <= 499 * HOUR_MS)).toBe(true);
  expect(requests[1][0]).toBe(requests[0][1] + HOUR_MS);
});
