import { createClient } from "@supabase/supabase-js";
import { HOUR_MS, rankStocks, type FuturesSymbol, type VolumeTicker } from "../src/lib/market";
import { completedHour, importOpenInterest, incrementalStart, parseCompletedCandles, parseFundingEvents } from "../src/lib/sync-logic";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
if (!supabaseUrl || !secretKey) {
  throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY before running bun run sync");
}

const db = createClient(supabaseUrl, secretKey, { auth: { persistSession: false } });
const FUTURES = "https://fapi.binance.com";
const SPOT = "https://data-api.binance.vision";
const PAGE_SIZE = 1000;

async function getJson<T>(url: string): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (response.ok) return await response.json() as T;
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`${url}: HTTP ${response.status}: ${await response.text()}`);
      }
      if (attempt === 4) throw new Error(`${url}: HTTP ${response.status}`);
    } catch (error) {
      if (attempt === 4) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 8000)));
  }
  throw new Error(`Could not fetch ${url}`);
}

async function upsertBatches(table: "hourly_prices" | "funding_events" | "hourly_open_interest", rows: Record<string, unknown>[]) {
  for (let index = 0; index < rows.length; index += 500) {
    const { error } = await db.from(table).upsert(rows.slice(index, index + 500));
    if (error) throw new Error(`${table} upsert: ${error.message}`);
  }
}

async function latestTimestamp(table: "hourly_prices" | "funding_events" | "hourly_open_interest", ticker: string, market?: "perp" | "spot") {
  const field = table === "funding_events" ? "funding_time" : "bucket_start";
  let query = db.from(table).select(field).eq("ticker", ticker);
  if (market) query = query.eq("market", market);
  const { data, error } = await query.order(field, { ascending: false }).limit(1);
  if (error) throw new Error(`${table} latest: ${error.message}`);
  const record = data?.[0] as Record<string, string> | undefined;
  return record ? Date.parse(record[field]) : null;
}

async function syncOpenInterest(ticker: string, symbol: string, nowHour: number) {
  // Recheck Binance's whole available window: an earlier capped page may have
  // left gaps even when the latest stored hour is current.
  const firstBucket = nowHour - 30 * 24 * HOUR_MS;
  return importOpenInterest(firstBucket, nowHour, async (startTime, endTime) => {
    const url = new URL("/futures/data/openInterestHist", FUTURES);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("period", "1h");
    url.searchParams.set("startTime", String(startTime));
    url.searchParams.set("endTime", String(endTime));
    url.searchParams.set("limit", "500");
    return getJson<unknown>(url.toString());
  }, async (rows) => {
    await upsertBatches("hourly_open_interest", rows.map((row) => ({ ticker, perp_symbol: symbol, ...row })));
  });
}

async function syncCandles(ticker: string, symbol: string, market: "perp" | "spot", nowHour: number) {
  const latest = await latestTimestamp("hourly_prices", ticker, market);
  let cursor = incrementalStart(latest, nowHour, 2 * HOUR_MS);
  const base = market === "perp" ? FUTURES : SPOT;
  const path = market === "perp" ? "/fapi/v1/klines" : "/api/v3/klines";
  let count = 0;
  while (cursor < nowHour) {
    const url = new URL(path, base);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", "1h");
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(nowHour - 1));
    url.searchParams.set("limit", String(PAGE_SIZE));
    const raw = await getJson<unknown>(url.toString());
    const candles = parseCompletedCandles(raw, nowHour);
    if (candles.length === 0) break;
    await upsertBatches("hourly_prices", candles.map((candle) => ({ ticker, symbol, market, ...candle })));
    count += candles.length;
    const next = Date.parse(candles[candles.length - 1].bucket_start) + HOUR_MS;
    if (next <= cursor) throw new Error(`Candle pagination did not advance for ${symbol}`);
    cursor = next;
    if ((raw as unknown[]).length < PAGE_SIZE) break;
  }
  return count;
}

async function syncFunding(ticker: string, symbol: string, nowHour: number) {
  const latest = await latestTimestamp("funding_events", ticker);
  let cursor = incrementalStart(latest, nowHour, 24 * HOUR_MS);
  let count = 0;
  while (cursor < nowHour) {
    const url = new URL("/fapi/v1/fundingRate", FUTURES);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(nowHour - 1));
    url.searchParams.set("limit", String(PAGE_SIZE));
    const raw = await getJson<unknown>(url.toString());
    const events = parseFundingEvents(raw, nowHour);
    if (events.length === 0) break;
    await upsertBatches("funding_events", events.map((event) => ({ ticker, perp_symbol: symbol, ...event })));
    count += events.length;
    // Inclusive cursor keeps a Regular/Special pair with the same timestamp intact.
    const next = Date.parse(events[events.length - 1].funding_time);
    if (next <= cursor) throw new Error(`Funding pagination did not advance for ${symbol}`);
    cursor = next;
    if ((raw as unknown[]).length < PAGE_SIZE) break;
  }
  return count;
}

async function run() {
  const nowHour = completedHour(Date.now());
  const { data: runRow, error: runError } = await db.from("sync_runs")
    .insert({ status: "running", data_through: new Date(nowHour).toISOString() })
    .select("id").single();
  if (runError) throw new Error(`Create sync run: ${runError.message}. Apply the Supabase migration first.`);
  const runId = runRow.id as number;
  const errors: string[] = [];
  try {
    const [futuresInfo, spotInfo, volumes] = await Promise.all([
      getJson<{ symbols: FuturesSymbol[] }>(`${FUTURES}/fapi/v1/exchangeInfo`),
      getJson<{ symbols: { symbol: string; status: string }[] }>(`${SPOT}/api/v3/exchangeInfo`),
      getJson<VolumeTicker[]>(`${FUTURES}/fapi/v1/ticker/24hr`),
    ]);
    const spots = new Set(spotInfo.symbols.filter((symbol) => symbol.status === "TRADING").map((symbol) => symbol.symbol));
    const stocks = rankStocks(futuresInfo.symbols, volumes, spots);
    if (stocks.length < 20) throw new Error(`Only ${stocks.length} eligible US stock perps found; expected 20`);

    for (const stock of stocks) {
      try {
        const perpCount = await syncCandles(stock.ticker, stock.perp_symbol, "perp", nowHour);
        const spotCount = stock.spot_symbol ? await syncCandles(stock.ticker, stock.spot_symbol, "spot", nowHour) : 0;
        const fundingCount = await syncFunding(stock.ticker, stock.perp_symbol, nowHour);
        let openInterestCount = 0;
        try {
          openInterestCount = await syncOpenInterest(stock.ticker, stock.perp_symbol, nowHour);
        } catch (error) {
          const message = `${stock.ticker} OI: ${error instanceof Error ? error.message : String(error)}`;
          errors.push(message);
          console.error(message);
        }
        console.log(`${stock.rank}. ${stock.ticker}: ${perpCount} perp, ${spotCount} spot candles; ${fundingCount} funding events; ${openInterestCount} OI hours`);
      } catch (error) {
        const message = `${stock.ticker}: ${error instanceof Error ? error.message : String(error)}`;
        errors.push(message);
        console.error(message);
      }
    }

    const { data: previouslyActive, error: activeError } = await db.from("tracked_stocks").select("ticker").eq("active", true);
    if (activeError) throw new Error(`Read tracked stocks: ${activeError.message}`);
    const selected = new Set(stocks.map((stock) => stock.ticker));
    for (const old of previouslyActive ?? []) {
      if (!selected.has(old.ticker)) {
        const { error } = await db.from("tracked_stocks").update({ active: false }).eq("ticker", old.ticker);
        if (error) throw new Error(`Deactivate ${old.ticker}: ${error.message}`);
      }
    }
    const { error: stockError } = await db.from("tracked_stocks").upsert(stocks.map((stock) => ({
      ...stock, active: true, updated_at: new Date().toISOString(),
    })));
    if (stockError) throw new Error(`Upsert tracked stocks: ${stockError.message}`);

    const cutoff = new Date(nowHour - 90 * 24 * HOUR_MS).toISOString();
    for (const table of ["hourly_prices", "funding_events", "hourly_open_interest"] as const) {
      const field = table === "funding_events" ? "funding_time" : "bucket_start";
      const { error } = await db.from(table).delete().lt(field, cutoff);
      if (error) errors.push(`Prune ${table}: ${error.message}`);
    }
    const status = errors.length ? "partial" : "success";
    const { error: finishError } = await db.from("sync_runs").update({
      status, finished_at: new Date().toISOString(), error_message: errors.length ? errors.join("\n") : null,
    }).eq("id", runId);
    if (finishError) throw new Error(`Finish sync run: ${finishError.message}`);
    console.log(`Sync ${status}: ${stocks.length} stocks`);
    if (errors.length) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.from("sync_runs").update({ status: "failed", finished_at: new Date().toISOString(), error_message: message }).eq("id", runId);
    throw error;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
