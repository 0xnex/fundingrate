import { createClient } from "@supabase/supabase-js";
import { DAY_MS } from "./market";
import type { FundingEvent, HourlyPrice } from "./analytics";
import type { MarketSnapshot } from "./strategy";

export interface TrackedStock {
  ticker: string;
  perp_symbol: string;
  spot_symbol: string | null;
  rank: number;
  quote_volume_24h: number;
  active: boolean;
  updated_at: string;
}

export interface SyncRun {
  id: number;
  started_at: string;
  finished_at: string | null;
  data_through: string;
  status: "running" | "success" | "partial" | "failed";
  error_message: string | null;
}

type PriceRow = HourlyPrice & {
  symbol: string;
  open: number;
  high: number;
  low: number;
  volume: number;
};

export interface OpenInterestRow {
  ticker: string;
  bucket_start: string;
  open_interest: number;
  open_interest_value: number;
}

let client: ReturnType<typeof createClient> | null = null;
function supabase() {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase public environment variables are missing");
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

function unwrap<T>(data: T | null, error: { message: string } | null): T {
  if (error) throw new Error(error.message);
  if (data === null) throw new Error("Supabase returned no data");
  return data;
}

export async function fetchStocks(): Promise<TrackedStock[]> {
  const { data, error } = await supabase().from("tracked_stocks").select("*").eq("active", true).order("rank");
  return unwrap(data, error) as TrackedStock[];
}

export async function fetchStock(ticker: string): Promise<TrackedStock | null> {
  const { data, error } = await supabase().from("tracked_stocks").select("*").eq("ticker", ticker).maybeSingle();
  if (error) throw new Error(error.message);
  return data as TrackedStock | null;
}

export async function fetchLatestRun(): Promise<SyncRun | null> {
  const { data, error } = await supabase().from("sync_runs").select("*").order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return data as SyncRun | null;
}

export async function fetchFunding(tickers: string[], through: string): Promise<FundingEvent[]> {
  if (tickers.length === 0) return [];
  const from = new Date(Date.parse(through) - 90 * DAY_MS).toISOString();
  const rows: FundingEvent[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase().from("funding_events")
      .select("ticker,funding_time,funding_rate,rate_type")
      .in("ticker", tickers).gte("funding_time", from).lt("funding_time", through)
      .order("funding_time").order("ticker").order("rate_type")
      .range(offset, offset + 999);
    const page = unwrap(data, error) as FundingEvent[];
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

export async function fetchPrices(ticker: string, through: string, days = 90): Promise<PriceRow[]> {
  const from = new Date(Date.parse(through) - days * DAY_MS).toISOString();
  const rows: PriceRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase().from("hourly_prices")
      .select("ticker,market,symbol,bucket_start,open,high,low,close,volume")
      .eq("ticker", ticker).gte("bucket_start", from).lt("bucket_start", through)
      .order("bucket_start").order("market").range(offset, offset + 999);
    const page = unwrap(data, error) as PriceRow[];
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

export async function fetchOverviewPrices(tickers: string[], through: string): Promise<HourlyPrice[]> {
  if (tickers.length === 0) return [];
  const from = new Date(Date.parse(through) - 90 * DAY_MS).toISOString();
  const groups = Array.from({ length: Math.ceil(tickers.length / 5) }, (_, index) => tickers.slice(index * 5, index * 5 + 5));
  const pages = await Promise.all(groups.map(async (group) => {
    const rows: HourlyPrice[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase().from("hourly_prices")
        .select("ticker,market,bucket_start,close")
        .in("ticker", group).gte("bucket_start", from).lt("bucket_start", through)
        .order("bucket_start").order("ticker").order("market").range(offset, offset + 999);
      const page = unwrap(data, error) as HourlyPrice[];
      rows.push(...page);
      if (page.length < 1000) return rows;
    }
  }));
  return pages.flat();
}

export async function fetchOpenInterest(tickers: string[], through: string, days = 90): Promise<OpenInterestRow[]> {
  if (!tickers.length) return [];
  const from = new Date(Date.parse(through) - days * DAY_MS).toISOString();
  const rows: OpenInterestRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase().from("hourly_open_interest")
      .select("ticker,bucket_start,open_interest,open_interest_value")
      .in("ticker", tickers).gte("bucket_start", from).lt("bucket_start", through)
      .order("bucket_start").order("ticker").range(offset, offset + 999);
    const page = unwrap(data, error) as OpenInterestRow[];
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

export async function fetchMarketSnapshots(tickers: string[]): Promise<MarketSnapshot[]> {
  if (!tickers.length) return [];
  const response = await fetch(`/api/market?tickers=${encodeURIComponent(tickers.join(","))}`);
  if (!response.ok) throw new Error(`Live Binance data request failed (${response.status})`);
  const data = await response.json() as { markets?: MarketSnapshot[] };
  if (!Array.isArray(data.markets)) throw new Error("Live Binance data is invalid");
  return data.markets;
}
