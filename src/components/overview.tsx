"use client";

import Link from "next/link";
import { ArrowRight, ArrowUpRight, BarChart3, Clock3, Coins, Layers3, Search } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { alignHourlyPrices, annualizedFundingApy, cumulativeFunding, fundingInWindow } from "@/lib/analytics";
import { fetchFunding, fetchLatestRun, fetchRecentPrices, fetchStocks } from "@/lib/data";
import { DAY_MS, HOUR_MS } from "@/lib/market";
import { FinancialChart, type ChartSeries } from "./financial-chart";
import { AppHeader, DataMessage, formatCompact, formatPct, formatUtc, PageFooter, RangePicker, signedClass, type RangeDays } from "./ui";

const EMPTY_STOCKS: Awaited<ReturnType<typeof fetchStocks>> = [];
const EMPTY_FUNDING: Awaited<ReturnType<typeof fetchFunding>> = [];
const EMPTY_PRICES: Awaited<ReturnType<typeof fetchRecentPrices>> = [];

export function Overview() {
  const [range, setRange] = useState<RangeDays>(7);
  const [search, setSearch] = useState("");
  const [viewNow] = useState(() => Date.now());
  const stocksQuery = useQuery({ queryKey: ["stocks"], queryFn: fetchStocks });
  const runQuery = useQuery({ queryKey: ["latest-run"], queryFn: fetchLatestRun });
  const stocks = stocksQuery.data ?? EMPTY_STOCKS;
  const run = runQuery.data;
  const through = run?.data_through ?? "";
  const tickers = stocks.map((stock) => stock.ticker);
  const fundingQuery = useQuery({ queryKey: ["funding", tickers.join(","), through], queryFn: () => fetchFunding(tickers, through), enabled: tickers.length > 0 && !!through });
  const pricesQuery = useQuery({ queryKey: ["recent-prices", tickers.join(","), through], queryFn: () => fetchRecentPrices(tickers, through), enabled: tickers.length > 0 && !!through });
  const endMs = through ? Date.parse(through) : 0;
  const startMs = endMs - range * DAY_MS;
  const funding = fundingQuery.data ?? EMPTY_FUNDING;
  const prices = pricesQuery.data ?? EMPTY_PRICES;

  const rows = useMemo(() => stocks.map((stock) => {
    const stockEvents = fundingInWindow(funding.filter((event) => event.ticker === stock.ticker), startMs, endMs);
    const regular = [...stockEvents].reverse().find((event) => event.rate_type === "Regular");
    const lastEvent = regular ?? stockEvents.at(-1);
    const basisPoints = alignHourlyPrices(prices.filter((price) => price.ticker === stock.ticker));
    const latestBasis = basisPoints.at(-1);
    return { ...stock, funding: stockEvents.length ? cumulativeFunding(stockEvents) : null, apy: annualizedFundingApy(stockEvents, range), latestRate: lastEvent ? lastEvent.funding_rate * 100 : null, latestBasis: stock.spot_symbol ? latestBasis?.basis ?? null : null, latestBasisTime: latestBasis?.time ?? null, latestPriceGap: stock.spot_symbol && latestBasis ? latestBasis.perp - latestBasis.spot : null, specialCount: stockEvents.filter((event) => event.rate_type === "Special").length };
  }), [stocks, funding, prices, startMs, endMs, range]);

  const visible = rows.filter((row) => row.ticker.toLowerCase().includes(search.trim().toLowerCase()));
  const matched = rows.filter((row) => row.latestBasis != null);
  const funded = rows.filter((row) => row.funding != null);
  const fundedCount = funded.length;
  const averageFunding = funded.length ? funded.reduce((sum, row) => sum + (row.funding ?? 0), 0) / funded.length : null;
  const apyRows = rows.filter((row) => row.apy != null);
  const averageApy = apyRows.length ? apyRows.reduce((sum, row) => sum + (row.apy ?? 0), 0) / apyRows.length : null;
  const meanBasis = matched.length ? matched.reduce((sum, row) => sum + (row.latestBasis ?? 0), 0) / matched.length : null;
  const staleHours = run?.finished_at ? (viewNow - Date.parse(run.finished_at)) / HOUR_MS : null;

  const curve = useMemo(() => {
    if (!fundedCount) return [];
    const hourly = new Map<number, number>();
    for (const event of fundingInWindow(funding, startMs, endMs)) {
      const hour = Math.floor(Date.parse(event.funding_time) / HOUR_MS) * HOUR_MS;
      hourly.set(hour, (hourly.get(hour) ?? 0) + event.funding_rate * 100 / fundedCount);
    }
    let total = 0;
    return [...hourly].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value: total += value }));
  }, [funding, fundedCount, startMs, endMs]);
  const chartSeries: ChartSeries[] = useMemo(() => [{ name: "Average cumulative funding", color: "#f2f2f2", steps: true, points: curve }], [curve]);

  const loading = stocksQuery.isLoading || runQuery.isLoading || fundingQuery.isLoading || pricesQuery.isLoading;
  const error = stocksQuery.error ?? runQuery.error ?? fundingQuery.error ?? pricesQuery.error;
  const needsMigration = error?.message.includes("Could not find the table");
  return <div className="site-shell"><AppHeader /><main className="main-container">
    <div className="eyebrow"><span className="eyebrow-line" /> BINANCE STOCK PERPETUALS / US COMPANIES</div>
    <div className="page-heading"><div><h1>Funding &amp; price gap<span className="accent-period">.</span></h1><p>What shorts received, what that pace implies, and how far perpetuals trade from spot.</p></div><div className="heading-control"><span>ANALYSIS WINDOW</span><RangePicker value={range} onChange={setRange} /></div></div>

    <div className="status-strip"><div><span className={`status-dot ${run?.status === "success" && (staleHours ?? 0) < 24 ? "" : "status-warning"}`} /> {run ? `${run.status === "success" ? "Data synced" : `Sync ${run.status}`} · ${formatUtc(run.finished_at ?? run.started_at)}` : "Waiting for first sync"}</div><span>{staleHours != null && staleHours >= 24 ? `Data is ${Math.floor(staleHours)} hours old · run bun run sync to refresh` : "Hourly UTC buckets · public read-only data"}</span></div>

    {error && !needsMigration && <div className="error-banner">Data request failed: {error.message}</div>}
    {!loading && (!run || needsMigration) && <DataMessage title="No market data yet">Apply the Supabase migration, set your local secret key, then run <code>bun run sync</code>.</DataMessage>}

    <section className="stat-grid" aria-label="Market summary">
      <div className="stat-card stat-card-primary"><div className="stat-label"><span>AVG. CUMULATIVE FUNDING</span><Coins size={17} /></div><div className={`stat-value ${signedClass(averageFunding)}`}>{formatPct(averageFunding, 2)}</div><div className="stat-foot">Actual payments over {range} days · {funded.length} stocks</div></div>
      <div className="stat-card"><div className="stat-label"><span>EST. FUNDING APY</span><Layers3 size={17} /></div><div className={`stat-value ${signedClass(averageApy)}`}>{formatPct(averageApy, 1)}</div><div className="stat-foot">Compounded pace · {apyRows.length} stocks</div></div>
      <div className="stat-card"><div className="stat-label"><span>AVG. PERP / SPOT GAP</span><BarChart3 size={17} /></div><div className={`stat-value ${signedClass(meanBasis)}`}>{formatPct(meanBasis, 2)}</div><div className="stat-foot">Latest matched hour · {matched.length} spot pairs</div></div>
      <div className="stat-card"><div className="stat-label"><span>TRACKED MARKETS</span><Layers3 size={17} /></div><div className="stat-value">{loading ? "—" : rows.length}<span className="stat-unit"> stocks</span></div><div className="stat-foot">Top contracts by 24h volume</div></div>
    </section>

    <section className="overview-grid"><div className="panel chart-panel"><div className="panel-heading"><div><div className="section-kicker">SETTLED FUNDING</div><h2>Funding accumulation</h2><p>Equal-weight average for the current tracked stocks.</p></div><div className="chart-key"><span className="key-dot" /> Short perpetual side</div></div>{curve.length ? <FinancialChart series={chartSeries} height={270} /> : <div className="empty-chart">Funding history will appear after the first sync.</div>}<div className="chart-caption">Cumulative actual rates (%) · above zero means the short side received funding · includes special events</div></div>
      <div className="panel insight-panel"><div className="section-kicker">READING THE NUMBERS</div><h2>Three measures,<br /><span>one window.</span></h2><div className="insight-rule" /><div className="insight-item"><span className="insight-icon funding-icon"><Coins size={18} /></span><div><strong>Cumulative funding</strong><small>Sum of actual event rates in the selected window.</small></div></div><div className="insight-item"><span className="insight-icon"><Layers3 size={18} /></span><div><strong>Estimated APY</strong><small>Observed payments compounded, then repeated for a year. Indicative, before fees.</small></div></div><div className="insight-item"><span className="insight-icon basis-icon"><BarChart3 size={18} /></span><div><strong>Perp / spot gap</strong><small>(Perp close ÷ spot close − 1) × 100 at a matching UTC hour.</small></div></div></div>
    </section>

    <section className="panel market-panel"><div className="market-heading"><div><div className="section-kicker">THE UNIVERSE</div><h2>Stock perpetuals <span className="count-badge">{rows.length}</span></h2><p>Ranked by Binance perpetual 24-hour quote volume. Select a stock for its full history.</p></div><label className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search ticker" aria-label="Search ticker" /></label></div><div className="table-wrap"><table><thead><tr><th>RANK / STOCK</th><th>{range}D FUNDING</th><th>EST. APY</th><th>PERP / SPOT GAP</th><th>LATEST FUNDING</th><th>24H VOLUME</th><th>PAIR</th><th aria-label="Open stock details" /></tr></thead><tbody>{visible.map((row) => <tr key={row.ticker}><td><Link href={`/stocks/${row.ticker}`} className="ticker-cell"><span className="rank-number">{String(row.rank).padStart(2, "0")}</span><span className="ticker-avatar">{row.ticker.slice(0, 2)}</span><span><strong>{row.ticker}</strong><small>{row.perp_symbol}</small></span></Link></td><td className={`number-cell metric-cell ${signedClass(row.funding)}`}>{formatPct(row.funding, 2)}</td><td className={`number-cell metric-cell ${signedClass(row.apy)}`}>{formatPct(row.apy, 1)}</td><td className={`number-cell metric-cell ${signedClass(row.latestBasis)}`}>{formatPct(row.latestBasis, 2)}<small>{row.latestPriceGap == null ? "Spot unavailable" : `${row.latestPriceGap >= 0 ? "+" : "−"}$${Math.abs(row.latestPriceGap).toFixed(2)} USDT`}</small></td><td className={`number-cell ${signedClass(row.latestRate)}`}>{formatPct(row.latestRate)}</td><td className="number-cell">${formatCompact(row.quote_volume_24h)}</td><td>{row.spot_symbol ? <span className="pair-tag"><span /> {row.spot_symbol}</span> : <span className="no-pair">Funding only</span>}</td><td><Link href={`/stocks/${row.ticker}`} className="row-link" aria-label={`View ${row.ticker}`}><ArrowUpRight size={17} /></Link></td></tr>)}</tbody></table>{!loading && visible.length === 0 && <div className="table-empty">{stocks.length ? "No stocks match your search." : "No imported stocks yet."}</div>}</div><div className="table-footer"><span><Clock3 size={14} /> Data through {formatUtc(run?.data_through)}</span><span>All figures are unlevered and before fees <ArrowRight size={14} /></span></div></section>
  </main><PageFooter /></div>;
}
