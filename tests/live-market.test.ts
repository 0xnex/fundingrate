import { expect, test } from "bun:test";
import { fetchMarketSnapshot, type MarketFetcher } from "../src/lib/live-market";
import type { TrackedStock } from "../src/lib/data";

const stock: TrackedStock = {
  ticker: "SNDK", perp_symbol: "SNDKUSDT", spot_symbol: "SNDKBUSDT",
  rank: 1, quote_volume_24h: 0, active: true, updated_at: "2026-09-29T00:00:00Z",
};

test("a rejected futures region identifies the failed live inputs without discarding the spot book", async () => {
  const fetcher: MarketFetcher = async (url) => {
    if (url.includes("data-api.binance.vision")) {
      return Response.json({ bids: [["100", "2"]], asks: [["101", "2"]] });
    }
    return new Response("", { status: 451 });
  };

  const snapshot = await fetchMarketSnapshot(stock, fetcher);
  expect(snapshot.error).toBe("Unavailable: funding quote (HTTP 451), open interest (HTTP 451), perpetual book (HTTP 451)");
  expect(snapshot.perpBook).toBeNull();
  expect(snapshot.spotBook?.asks).toEqual([[101, 2]]);
});

test("a browser depth request can ask Binance for 500 levels on both legs", async () => {
  const requested: string[] = [];
  const fetcher: MarketFetcher = async (url) => {
    requested.push(url);
    if (url.includes("premiumIndex")) return Response.json({ lastFundingRate: "0.0001", time: Date.now(), markPrice: "100" });
    if (url.includes("openInterest")) return Response.json({ openInterest: "1000", time: Date.now() });
    return Response.json({ bids: [["99", "2"]], asks: [["101", "2"]] });
  };
  const snapshot = await fetchMarketSnapshot(stock, fetcher, 500);
  expect(requested.filter((url) => url.includes("/depth?"))).toHaveLength(2);
  expect(requested.filter((url) => url.includes("/depth?")).every((url) => url.includes("limit=500"))).toBe(true);
  expect(snapshot.perpBook?.bids).toEqual([[99, 2]]);
  expect(snapshot.spotBook?.asks).toEqual([[101, 2]]);
});
