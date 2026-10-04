import { fetchStocks } from "@/lib/data";
import { fetchMarketSnapshot } from "@/lib/live-market";
import type { MarketSnapshot } from "@/lib/strategy";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const requested = new URL(request.url).searchParams.get("tickers")?.split(",").filter(Boolean) ?? [];
  if (!requested.length || requested.length > 20 || requested.some((ticker) => !/^[A-Z0-9]{1,8}$/.test(ticker)) || new Set(requested).size !== requested.length) {
    return Response.json({ error: "Provide 1 to 20 distinct tracked tickers" }, { status: 400 });
  }
  try {
    const stocks = await fetchStocks();
    const byTicker = new Map(stocks.map((stock) => [stock.ticker, stock]));
    if (requested.some((ticker) => !byTicker.has(ticker))) return Response.json({ error: "Unknown tracked ticker" }, { status: 400 });
    const results: MarketSnapshot[] = [];
    for (let index = 0; index < requested.length; index += 4) {
      results.push(...await Promise.all(requested.slice(index, index + 4).map((ticker) => fetchMarketSnapshot(byTicker.get(ticker)!))));
    }
    return Response.json({ markets: results }, { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=15" } });
  } catch {
    return Response.json({ error: "Market data is temporarily unavailable" }, { status: 503 });
  }
}
