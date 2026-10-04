import type { TrackedStock } from "./data";
import type { BookLevel, MarketSnapshot, OrderBook } from "./strategy";

const FUTURES = "https://fapi.binance.com";
const SPOT = "https://data-api.binance.vision";
export type MarketFetcher = (url: string, init?: RequestInit) => Promise<Response>;

class BinanceHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

async function getJson(url: string, fetcher: MarketFetcher): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetcher(url, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
      if (response.ok) return response.json();
      throw new BinanceHttpError(response.status);
    } catch (error) {
      if (error instanceof BinanceHttpError && error.status < 500 && error.status !== 429) throw error;
      if (attempt === 1) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Binance request failed");
}

function number(value: unknown): number | null {
  const parsed = Number(value);
  return value == null || !Number.isFinite(parsed) ? null : parsed;
}

function book(raw: unknown, fetchedAt: string): OrderBook {
  if (typeof raw !== "object" || raw === null) throw new Error("Invalid Binance order book");
  const data = raw as Record<string, unknown>;
  function levels(value: unknown): BookLevel[] {
    if (!Array.isArray(value)) throw new Error("Invalid Binance depth levels");
    return value.map((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) throw new Error("Invalid Binance depth level");
      const price = Number(entry[0]);
      const quantity = Number(entry[1]);
      if (!(price > 0 && quantity >= 0)) throw new Error("Invalid Binance depth value");
      return [price, quantity] as BookLevel;
    }).filter(([, quantity]) => quantity > 0);
  }
  return { bids: levels(data.bids), asks: levels(data.asks), fetchedAt, sourceTime: number(data.T) ?? undefined };
}

function failureReason(reason: unknown): string {
  if (reason instanceof BinanceHttpError) return reason.message;
  if (reason instanceof Error && (reason.name === "TimeoutError" || reason.name === "AbortError")) return "timeout";
  return "network error";
}

export async function fetchMarketSnapshot(stock: TrackedStock, fetcher: MarketFetcher = fetch, depthLimit: 100 | 500 = 100): Promise<MarketSnapshot> {
  const urls = [
    `${FUTURES}/fapi/v1/premiumIndex?symbol=${stock.perp_symbol}`,
    `${FUTURES}/fapi/v1/openInterest?symbol=${stock.perp_symbol}`,
    `${FUTURES}/fapi/v1/depth?symbol=${stock.perp_symbol}&limit=${depthLimit}`,
    stock.spot_symbol ? `${SPOT}/api/v3/depth?symbol=${stock.spot_symbol}&limit=${depthLimit}` : null,
  ];
  const responses = await Promise.allSettled(urls.map((url) => url ? getJson(url, fetcher) : Promise.resolve(null)));
  const fetchedAt = new Date().toISOString();
  const values = responses.map((result) => result.status === "fulfilled" ? result.value : null);
  const premium = typeof values[0] === "object" && values[0] !== null ? values[0] as Record<string, unknown> : null;
  const interest = typeof values[1] === "object" && values[1] !== null ? values[1] as Record<string, unknown> : null;
  let perpBook: OrderBook | null = null;
  let spotBook: OrderBook | null = null;
  try { if (values[2]) perpBook = book(values[2], fetchedAt); } catch { /* A malformed book is unavailable. */ }
  try { if (values[3]) spotBook = book(values[3], fetchedAt); } catch { /* A malformed book is unavailable. */ }
  const names = ["funding quote", "open interest", "perpetual book", "spot book"];
  const failures = responses.flatMap((result, index) => result.status === "rejected" ? [`${names[index]} (${failureReason(result.reason)})`] : []);
  if (values[2] && !perpBook) failures.push("perpetual book (invalid response)");
  if (values[3] && !spotBook) failures.push("spot book (invalid response)");
  return {
    ticker: stock.ticker, fetchedAt,
    fundingRate: number(premium?.lastFundingRate),
    quoteTime: number(premium?.time),
    nextFundingTime: number(premium?.nextFundingTime),
    markPrice: number(premium?.markPrice),
    openInterest: number(interest?.openInterest),
    openInterestTime: number(interest?.time),
    perpBook, spotBook,
    ...(failures.length ? { error: `Unavailable: ${failures.join(", ")}` } : {}),
  };
}
