export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const HISTORY_DAYS = 90;

// US-incorporated single-stock issuers with Binance TradFi perpetual symbols.
// New listings require review before entering the ranked universe.
export const US_STOCK_TICKERS = [
  "AAPL", "AAOI", "ADBE", "AGPU", "ALAB", "AMAT", "AMC", "AMD", "AMZN",
  "ANET", "APLD", "APP", "ASTS", "AVGO", "AXTI", "BE", "BMNR", "BNC",
  "BRKB", "BX", "CAT", "CIEN", "COHR", "COIN", "COST", "CRCL", "CRDO",
  "CRM", "CRWD", "CRWV", "CSCO", "CVNA", "DDOG", "DELL", "DIS", "DJT",
  "DKNG", "EBAY", "FLNC", "GEV", "GLW", "GME", "GPRO", "GS", "HD",
  "HIMS", "HOOD", "HPE", "IBM", "INTC", "IONQ", "JPM", "KLAC", "KO",
  "LITE", "LLY", "LRCX", "MARA", "MDB", "META", "MRK", "MRNA", "MRVL",
  "MSFT", "MSTR", "MU", "NET", "NFLX", "NVDA", "OKLO", "ONDS", "ORCL",
  "PANW", "PAYP", "PLTR", "QCOM", "RDDT", "RIVN", "RKLB", "RUM",
  "SMCI", "SNDK", "SNOW", "SOFI", "TEAM", "TEM", "TER", "TSLA", "TTWO",
  "TXN", "UBER", "USAR", "V", "VRT", "VST", "WDC", "WMT", "XOM", "ZM",
  "ZS",
] as const;

export const US_STOCK_SET = new Set<string>(US_STOCK_TICKERS);

export const SPOT_ASSET_OVERRIDES: Record<string, string> = {
  PAYP: "PYPLB",
  BRKB: "BRKBB",
};

export function expectedSpotSymbol(ticker: string): string {
  return `${SPOT_ASSET_OVERRIDES[ticker] ?? `${ticker}B`}USDT`;
}

export interface FuturesSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  contractType: string;
  underlyingType: string;
}

export interface VolumeTicker {
  symbol: string;
  quoteVolume: string;
}

export interface RankedStock {
  ticker: string;
  perp_symbol: string;
  spot_symbol: string | null;
  quote_volume_24h: number;
  rank: number;
}

export function rankStocks(
  futures: FuturesSymbol[],
  volumes: VolumeTicker[],
  spotSymbols: Set<string>,
): RankedStock[] {
  const volumeBySymbol = new Map(volumes.map((item) => [item.symbol, Number(item.quoteVolume)]));
  return futures
    .filter((item) =>
      item.status === "TRADING" &&
      item.contractType === "TRADIFI_PERPETUAL" &&
      item.underlyingType === "EQUITY" &&
      item.quoteAsset === "USDT" &&
      item.symbol === `${item.baseAsset}USDT` &&
      US_STOCK_SET.has(item.baseAsset),
    )
    .map((item) => {
      const spot = expectedSpotSymbol(item.baseAsset);
      return {
        ticker: item.baseAsset,
        perp_symbol: item.symbol,
        spot_symbol: spotSymbols.has(spot) ? spot : null,
        quote_volume_24h: volumeBySymbol.get(item.symbol) ?? 0,
        rank: 0,
      };
    })
    .filter((item) => Number.isFinite(item.quote_volume_24h) && item.quote_volume_24h > 0)
    .sort((a, b) => b.quote_volume_24h - a.quote_volume_24h || a.ticker.localeCompare(b.ticker))
    .slice(0, 20)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}
