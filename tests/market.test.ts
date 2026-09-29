import { describe, expect, test } from "bun:test";
import { alignHourlyPrices, annualizedFundingApy, cumulativeFunding, fundingInWindow, normalizePrices } from "../src/lib/analytics";
import { HOUR_MS, rankStocks, type FuturesSymbol } from "../src/lib/market";
import { completedHour, incrementalStart, parseCompletedCandles, parseFundingEvents } from "../src/lib/sync-logic";

const future = (ticker: string, overrides: Partial<FuturesSymbol> = {}): FuturesSymbol => ({
  symbol: `${ticker}USDT`, baseAsset: ticker, quoteAsset: "USDT", status: "TRADING",
  contractType: "TRADIFI_PERPETUAL", underlyingType: "EQUITY", ...overrides,
});

describe("rankStocks", () => {
  test("selects the highest-volume US company contracts and marks missing spot pairs", () => {
    const futures = [future("TSLA"), future("AAPL"), future("TSM"), future("SPY"), future("NVDA", { status: "BREAK" })];
    const ranked = rankStocks(futures, [
      { symbol: "TSLAUSDT", quoteVolume: "200" },
      { symbol: "AAPLUSDT", quoteVolume: "300" },
      { symbol: "TSMUSDT", quoteVolume: "1000" },
      { symbol: "SPYUSDT", quoteVolume: "900" },
    ], new Set(["AAPLBUSDT"]));
    expect(ranked.map((stock) => stock.ticker)).toEqual(["AAPL", "TSLA"]);
    expect(ranked.map((stock) => stock.rank)).toEqual([1, 2]);
    expect(ranked.map((stock) => stock.spot_symbol)).toEqual(["AAPLBUSDT", null]);
  });
});

describe("hourly analysis", () => {
  test("aligns matching UTC hours only and calculates signed basis", () => {
    const t = Date.parse("2026-09-01T00:00:00Z");
    const prices = [
      { ticker: "TSLA", market: "perp" as const, bucket_start: new Date(t).toISOString(), close: 110 },
      { ticker: "TSLA", market: "spot" as const, bucket_start: new Date(t).toISOString(), close: 100 },
      { ticker: "TSLA", market: "perp" as const, bucket_start: new Date(t + HOUR_MS).toISOString(), close: 115 },
      { ticker: "TSLA", market: "spot" as const, bucket_start: new Date(t + 2 * HOUR_MS).toISOString(), close: 120 },
    ];
    const points = alignHourlyPrices(prices);
    expect(points).toHaveLength(1);
    expect(points[0].basis).toBeCloseTo(10);
    expect(normalizePrices(points)[0]).toEqual({ time: t, perp: 0, spot: 0 });
  });

  test("sums actual regular and special payments with short-side sign", () => {
    const events = [
      { ticker: "AAPL", funding_time: "2026-09-01T00:00:00.001Z", funding_rate: 0.001, rate_type: "Regular" },
      { ticker: "AAPL", funding_time: "2026-09-01T00:00:00.002Z", funding_rate: -0.0002, rate_type: "Special" },
      { ticker: "AAPL", funding_time: "2026-09-02T00:00:00Z", funding_rate: 0.01, rate_type: "Regular" },
    ];
    const selected = fundingInWindow(events, Date.parse("2026-09-01T00:00:00Z"), Date.parse("2026-09-02T00:00:00Z"));
    expect(selected).toHaveLength(2);
    expect(cumulativeFunding(selected)).toBeCloseTo(0.08);
    expect(annualizedFundingApy(selected, 1)).toBeCloseTo(((1.001 * 0.9998) ** 365 - 1) * 100);
    expect(annualizedFundingApy([], 7)).toBeNull();
    expect(annualizedFundingApy([{ ...events[0], funding_rate: -0.001 }], 30)).toBeLessThan(0);
  });
});

describe("sync parsing and catch-up", () => {
  test("uses a two-hour overlap without exceeding the 90-day cutoff", () => {
    const now = Date.parse("2026-09-29T12:43:00Z");
    const hour = completedHour(now);
    expect(hour).toBe(Date.parse("2026-09-29T12:00:00Z"));
    expect(incrementalStart(hour - HOUR_MS, hour, 2 * HOUR_MS)).toBe(hour - 3 * HOUR_MS);
    expect(incrementalStart(null, hour, 2 * HOUR_MS)).toBe(hour - 90 * 24 * HOUR_MS);
  });

  test("drops the in-progress hour and preserves millisecond event times and types", () => {
    const hour = Date.parse("2026-09-29T12:00:00Z");
    const raw = (time: number) => [time, "10", "12", "9", "11", "20"];
    expect(parseCompletedCandles([raw(hour - HOUR_MS), raw(hour)], hour)).toHaveLength(1);
    const events = parseFundingEvents([{ fundingTime: hour + 2, fundingRate: "-0.0001", rateType: "Special", markPrice: "11" }], hour + 3);
    expect(events[0]).toEqual({ funding_time: "2026-09-29T12:00:00.002Z", funding_rate: -0.0001, rate_type: "Special", mark_price: 11 });
  });
});
