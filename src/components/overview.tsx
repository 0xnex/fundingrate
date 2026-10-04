"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { alignHourlyPrices, cumulativeFunding, fundingInWindow } from "@/lib/analytics";
import { fetchFunding, fetchLatestRun, fetchOverviewPrices, fetchStocks } from "@/lib/data";
import { rankValues } from "@/lib/heatmap";
import { DAY_MS, HOUR_MS } from "@/lib/market";
import { summarizeFunding } from "@/lib/strategy";
import { AppHeader, DataMessage, formatPct, formatUtc, LoadingIndicator, PageFooter } from "./ui";

const WINDOWS = [1, 7, 30, 90] as const;
const EMPTY_STOCKS: Awaited<ReturnType<typeof fetchStocks>> = [];
const EMPTY_FUNDING: Awaited<ReturnType<typeof fetchFunding>> = [];
const EMPTY_PRICES: Awaited<ReturnType<typeof fetchOverviewPrices>> = [];

function formatBasis(value: number | null) {
  return value !== null && Math.abs(value) < 0.0005 ? "0.000%" : formatPct(value, 3);
}

const YIELD_HEAT = ["#542f3b", "#65403f", "#715045", "#74604e", "#687052", "#527a45", "#87ad4e", "#c7f36b"];
const BASIS_HEAT = ["#263c46", "#2e4a57", "#355967", "#3b6776", "#447787", "#5b93a2", "#66aabd", "#a1e3ed"];

function heatStyle(rank: number | null, metric: "yield" | "basis") {
  if (rank === null) return undefined;
  const step = Math.round(rank * 7);
  return { backgroundColor: (metric === "basis" ? BASIS_HEAT : YIELD_HEAT)[step], color: step >= (metric === "basis" ? 5 : 6) ? "#14200f" : "#f5f8f0" };
}

export function Overview() {
  const [viewNow] = useState(() => Date.now());
  const stocksQuery = useQuery({ queryKey: ["stocks"], queryFn: fetchStocks });
  const runQuery = useQuery({ queryKey: ["latest-run"], queryFn: fetchLatestRun });
  const stocks = stocksQuery.data ?? EMPTY_STOCKS;
  const run = runQuery.data;
  const through = run?.data_through ?? "";
  const tickers = stocks.map((stock) => stock.ticker);
  const spotTickers = stocks.filter((stock) => stock.spot_symbol).map((stock) => stock.ticker);
  const fundingQuery = useQuery({
    queryKey: ["funding", tickers.join(","), through],
    queryFn: () => fetchFunding(tickers, through),
    enabled: tickers.length > 0 && !!through,
  });
  const funding = fundingQuery.data ?? EMPTY_FUNDING;
  const pricesQuery = useQuery({
    queryKey: ["overview-prices", spotTickers.join(","), through],
    queryFn: () => fetchOverviewPrices(spotTickers, through),
    enabled: spotTickers.length > 0 && !!through,
    staleTime: 5 * 60_000,
  });
  const prices = pricesQuery.data ?? EMPTY_PRICES;
  const basisLoading = spotTickers.length > 0 && !!through && pricesQuery.isLoading;
  const endMs = through ? Date.parse(through) : 0;
  const staleHours = run?.finished_at ? (viewNow - Date.parse(run.finished_at)) / HOUR_MS : null;
  const rows = useMemo(() => {
    const byTicker = new Map<string, typeof funding>();
    const pricesByTicker = new Map<string, typeof prices>();
    for (const event of funding) {
      const list = byTicker.get(event.ticker) ?? [];
      list.push(event);
      byTicker.set(event.ticker, list);
    }
    for (const price of prices) {
      const list = pricesByTicker.get(price.ticker) ?? [];
      list.push(price);
      pricesByTicker.set(price.ticker, list);
    }
    return stocks.map((stock) => {
      const basisPoints = stock.spot_symbol ? alignHourlyPrices(pricesByTicker.get(stock.ticker) ?? []) : [];
      return {
        ticker: stock.ticker,
        hasSpotPair: !!stock.spot_symbol,
        values: WINDOWS.map((days) => {
          const startMs = endMs - days * DAY_MS;
          const stockFunding = byTicker.get(stock.ticker) ?? [];
          const events = fundingInWindow(stockFunding, startMs, endMs);
          const stats = summarizeFunding(stockFunding, endMs, days);
          const matched = basisPoints.filter((point) => point.time >= startMs && point.time < endMs);
          return {
            cumulative: events.length ? cumulativeFunding(events) : null,
            annualized: stats.regularCount ? (days === 1 ? stats.regularSum * 365 : stats.annualizedRate) * 100 : null,
            basis: matched.length ? matched.reduce((sum, point) => sum + point.basis, 0) / matched.length : null,
          };
        }),
      };
    });
  }, [stocks, funding, prices, endMs]);
  const heatRanks = useMemo(() => WINDOWS.map((_, index) => ({
    cumulative: rankValues(rows.map((row) => row.values[index].cumulative)),
    annualized: rankValues(rows.map((row) => row.values[index].annualized)),
    basis: rankValues(rows.map((row) => row.values[index].basis)),
  })), [rows]);

  const loading = stocksQuery.isLoading || runQuery.isLoading || fundingQuery.isLoading;
  const error = stocksQuery.error ?? runQuery.error ?? fundingQuery.error;
  const needsMigration = error?.message.includes("Could not find the table");
  const loadingLabel = stocksQuery.isLoading || runQuery.isLoading ? "Loading tracked stocks and sync status…"
    : fundingQuery.isLoading ? "Loading and calculating settled funding…"
      : basisLoading ? "Loading and calculating spot/perp basis for 24h, 7d, 30d, and 90d…"
        : stocksQuery.isFetching || runQuery.isFetching || fundingQuery.isFetching || pricesQuery.isFetching ? "Refreshing market data and recalculating the table…"
          : null;

  return <div className="site-shell overview-shell"><AppHeader /><main className="main-container">
    <div className="eyebrow"><span className="eyebrow-line" /> BINANCE STOCK PERPETUALS / US COMPANIES</div>
    <div className="page-heading"><div><h1>Stock funding history<span className="accent-period">.</span></h1><p>Actual cumulative funding and annualized regular funding pace for a short perpetual position. Positive means received; negative means paid.</p></div></div>
    <div className="status-strip"><div><span className={`status-dot ${run?.status === "success" && (staleHours ?? 0) < 24 ? "" : "status-warning"}`} /> {run ? `${run.status === "success" ? "Data synced" : `Sync ${run.status}`} · ${formatUtc(run.finished_at ?? run.started_at)}` : "Waiting for first sync"}</div><span>{staleHours != null && staleHours >= 24 ? `Data is ${Math.floor(staleHours)} hours old · run bun run sync to refresh` : "Settled events · UTC timestamps"}</span></div>
    {error && !needsMigration && <div className="error-banner">Data request failed: {error.message}</div>}
    {pricesQuery.error && <div className="error-banner">Basis history request failed: {pricesQuery.error.message}</div>}
    {!loading && (!run || needsMigration) && <DataMessage title="No market data yet">Apply the Supabase migration, set your local secret key, then run <code>bun run sync</code>.</DataMessage>}
    {loadingLabel && <LoadingIndicator label={loadingLabel} />}
    <section className="panel market-panel" aria-label="Stock funding history" aria-busy={!!loadingLabel}>
      <div className="table-wrap">
        <table className="funding-table">
          <thead><tr><th scope="col">STOCK</th>{WINDOWS.map((days) => <th scope="col" key={days} className="funding-period-heading"><span>{days === 1 ? "LATEST 24H" : `${days}D`}</span><span className="funding-column-headings"><span>FUNDING</span><span>APY</span><span>BASIS</span></span></th>)}</tr></thead>
          <tbody>{rows.map((row, rowIndex) => <tr key={row.ticker}>
            <td><Link href={`/stocks/${row.ticker}`} className="funding-stock-link"><strong>{row.ticker}</strong><span className="funding-details-label">View details <ArrowUpRight size={13} aria-hidden="true" /></span></Link></td>
            {row.values.map((value, index) => <td key={WINDOWS[index]} className="funding-window-cell">
              <span className="mobile-window-label">{WINDOWS[index] === 1 ? "24H" : `${WINDOWS[index]}D`}</span>
              <div className="funding-window-metrics">
                <span style={heatStyle(heatRanks[index].cumulative[rowIndex], "yield")}><small>Funding</small><b>{formatPct(value.cumulative, 2)}</b></span>
                <span style={heatStyle(heatRanks[index].annualized[rowIndex], "yield")}><small>APY</small><b>{formatPct(value.annualized, 1)}</b></span>
                <span style={heatStyle(heatRanks[index].basis[rowIndex], "basis")}><small>Basis</small><b>{basisLoading && row.hasSpotPair ? "…" : formatBasis(value.basis)}</b></span>
              </div>
            </td>)}
          </tr>)}</tbody>
        </table>
        {!loading && rows.length === 0 && <div className="table-empty">No imported stocks yet.</div>}
      </div>
      <p className="funding-table-note"><span className="heat-legend"><span>LOW → HIGH FUNDING / APY</span><i className="yield-scale" aria-hidden="true" /><span>LOW → HIGH BASIS</span><i className="basis-scale" aria-hidden="true" /></span> Values are ranked within the same window and metric; missing data stays neutral. Cumulative funding includes all settled events. APY is regular funding simply annualized before fees; 24h APY extrapolates one day. Basis is the average of matched hourly (perp close ÷ spot close − 1) × 100. A higher historical basis is not a guaranteed entry premium. Data through {formatUtc(through || null)}.</p>
    </section>
  </main><PageFooter /></div>;
}
