"use client";

import { Activity, ArrowDownRight, ArrowUpRight, BarChart3, Clock3, Coins, Info, Layers3 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { alignHourlyPrices, annualizedFundingApy, cumulativeFunding, fundingInWindow, normalizePrices } from "@/lib/analytics";
import { fetchFunding, fetchLatestRun, fetchPrices, fetchStock } from "@/lib/data";
import { DAY_MS, HOUR_MS } from "@/lib/market";
import { FinancialChart, type ChartSeries } from "./financial-chart";
import { AppHeader, BackLink, DataMessage, formatCompact, formatPct, formatUtc, PageFooter, RangePicker, signedClass, type RangeDays } from "./ui";

function withHourlyGaps(points: { time: number; value: number }[]) {
  if (points.length < 2) return points;
  const result: { time: number; value: number }[] = [];
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    const previous = points[index - 1];
    if (previous && point.time - previous.time > HOUR_MS) {
      result.push({ time: previous.time + HOUR_MS, value: Number.NaN });
      if (point.time - previous.time > 2 * HOUR_MS) result.push({ time: point.time - HOUR_MS, value: Number.NaN });
    }
    result.push(point);
  }
  return result;
}

export function StockDetail({ ticker }: { ticker: string }) {
  const [range, setRange] = useState<RangeDays>(30);
  const [viewNow] = useState(() => Date.now());
  const stockQuery = useQuery({ queryKey: ["stock", ticker], queryFn: () => fetchStock(ticker) });
  const runQuery = useQuery({ queryKey: ["latest-run"], queryFn: fetchLatestRun });
  const stock = stockQuery.data;
  const run = runQuery.data;
  const through = run?.data_through ?? "";
  const fundingQuery = useQuery({ queryKey: ["stock-funding", ticker, through], queryFn: () => fetchFunding([ticker], through), enabled: !!through && !!stock });
  const pricesQuery = useQuery({ queryKey: ["stock-prices", ticker, through], queryFn: () => fetchPrices(ticker, through), enabled: !!through && !!stock });
  const endMs = through ? Date.parse(through) : 0;
  const startMs = endMs - range * DAY_MS;
  const events = fundingInWindow(fundingQuery.data ?? [], startMs, endMs);
  const prices = (pricesQuery.data ?? []).filter((price) => Date.parse(price.bucket_start) >= startMs);
  const pairs = stock?.spot_symbol ? alignHourlyPrices(prices) : [];
  const normalized = normalizePrices(pairs);
  const perp = prices.filter((price) => price.market === "perp").sort((a, b) => Date.parse(a.bucket_start) - Date.parse(b.bucket_start));
  const perpFirst = perp[0]?.close;
  const cumulative = cumulativeFunding(events);
  const apy = annualizedFundingApy(events, range);
  const latestRegular = [...events].reverse().find((event) => event.rate_type === "Regular");
  const latestPair = pairs.at(-1);
  const latestBasis = latestPair?.basis ?? null;
  const latestPriceGap = latestPair ? latestPair.perp - latestPair.spot : null;
  const meanBasis = pairs.length ? pairs.reduce((sum, point) => sum + point.basis, 0) / pairs.length : null;
  const specialCount = events.filter((event) => event.rate_type === "Special").length;

  const priceSeries: ChartSeries[] = (() => {
    if (normalized.length) return [
      { name: "Perpetual price change", color: "#f2f2f2", points: withHourlyGaps(normalized.map((point) => ({ time: point.time, value: point.perp }))) },
      { name: "bStock price change", color: "#858585", dashed: true, points: withHourlyGaps(normalized.map((point) => ({ time: point.time, value: point.spot }))) },
    ];
    if (!perpFirst) return [];
    return [{ name: "Perpetual price change", color: "#f2f2f2", points: withHourlyGaps(perp.map((price) => ({ time: Date.parse(price.bucket_start), value: (price.close / perpFirst - 1) * 100 }))) }];
  })();
  const basisSeries: ChartSeries[] = [{ name: "Perpetual / spot basis", color: "#d0d0d0", points: withHourlyGaps(pairs.map((point) => ({ time: point.time, value: point.basis }))) }];
  const cumulativeByHour = new Map<number, number>();
  for (const event of events) {
    const hour = Math.floor(Date.parse(event.funding_time) / HOUR_MS) * HOUR_MS;
    cumulativeByHour.set(hour, (cumulativeByHour.get(hour) ?? 0) + event.funding_rate * 100);
  }
  let runningFunding = 0;
  const cumulativePoints: { time: number; value: number }[] = [];
  for (const [time, value] of [...cumulativeByHour].sort((a, b) => a[0] - b[0])) {
    runningFunding += value;
    cumulativePoints.push({ time, value: runningFunding });
  }
  const cumulativeSeries: ChartSeries[] = [{ name: "Cumulative funding", color: "#f2f2f2", steps: true, points: cumulativePoints }];
  const fundingSeries: ChartSeries[] = (() => {
    const byHour = new Map<number, { value: number; special: boolean }>();
    for (const event of events) {
      const hour = Math.floor(Date.parse(event.funding_time) / HOUR_MS) * HOUR_MS;
      const entry = byHour.get(hour) ?? { value: 0, special: false };
      entry.value += event.funding_rate * 100;
      entry.special ||= event.rate_type === "Special";
      byHour.set(hour, entry);
    }
    return [{ name: "Funding payments", color: "#eeeeee", points: [...byHour].sort((a, b) => a[0] - b[0]).map(([time, entry]) => ({ time, value: entry.value, color: entry.special ? "#aaaaaa" : entry.value >= 0 ? "#eeeeee" : "#777777" })) }];
  })();

  const loading = stockQuery.isLoading || runQuery.isLoading || fundingQuery.isLoading || pricesQuery.isLoading;
  const error = stockQuery.error ?? runQuery.error ?? fundingQuery.error ?? pricesQuery.error;
  const needsMigration = error?.message.includes("Could not find the table");
  return <div className="site-shell"><AppHeader ticker={ticker} /><main className="main-container detail-container">
    <BackLink />
    {error && !needsMigration && <div className="error-banner">Data request failed: {error.message}</div>}
    {needsMigration && <DataMessage title="No market data yet">Apply the Supabase migration and run <code>bun run sync</code> to load this stock.</DataMessage>}
    {!loading && !stock && !error && <DataMessage title="Stock not found">This ticker is not in the current tracked universe.</DataMessage>}
    {stock && <>
      <div className="detail-heading"><div className="detail-heading-left"><span className="detail-avatar">{ticker.slice(0, 2)}</span><div><div className="eyebrow"><span className="eyebrow-line" /> STOCK PERPETUAL / RANK #{stock.rank}</div><h1>{ticker}<span className="accent-period">.</span></h1><p>{stock.perp_symbol} perpetual {stock.spot_symbol ? <>· {stock.spot_symbol} spot</> : "· No matching Binance bStock pair"}</p></div></div><div className="heading-control"><span>TIME WINDOW</span><RangePicker value={range} onChange={setRange} /></div></div>

      <div className="detail-status"><span className="pair-tag"><span /> {stock.perp_symbol}</span>{stock.spot_symbol ? <span className="pair-tag spot-pair"><span /> {stock.spot_symbol}</span> : <span className="no-pair">Funding only</span>}<span className="detail-volume">24h perp volume ${formatCompact(stock.quote_volume_24h)}</span><span className="detail-status-right"><Clock3 size={14} /> Data through {formatUtc(through)}{run?.finished_at && viewNow - Date.parse(run.finished_at) >= DAY_MS && " · stale"}</span></div>

      <section className="stat-grid detail-stats" aria-label={`${ticker} summary`}>
        <div className="stat-card stat-card-primary"><div className="stat-label"><span>{range}D CUMULATIVE FUNDING</span><Coins size={17} /></div><div className={`stat-value ${signedClass(events.length ? cumulative : null)}`}>{formatPct(events.length ? cumulative : null, 2)}</div><div className="stat-foot">{events.length} actual payments · short side · before fees</div></div>
        <div className="stat-card"><div className="stat-label"><span>EST. FUNDING APY</span><Activity size={17} /></div><div className={`stat-value ${signedClass(apy)}`}>{formatPct(apy, 1)}</div><div className="stat-foot">Selected window repeated for a year</div></div>
        <div className="stat-card"><div className="stat-label"><span>LATEST PERP / SPOT GAP</span><BarChart3 size={17} /></div><div className={`stat-value ${signedClass(latestBasis)}`}>{formatPct(stock.spot_symbol ? latestBasis : null, 2)}</div><div className="stat-foot">{latestPriceGap == null ? "No matched hourly close" : `${latestPriceGap >= 0 ? "+" : "−"}$${Math.abs(latestPriceGap).toFixed(2)} USDT · ${formatUtc(latestPair?.time)}`}</div></div>
        <div className="stat-card"><div className="stat-label"><span>LATEST REGULAR FUNDING</span><Layers3 size={17} /></div><div className={`stat-value ${signedClass(latestRegular?.funding_rate)}`}>{formatPct(latestRegular ? latestRegular.funding_rate * 100 : null)}</div><div className="stat-foot">{latestRegular ? formatUtc(latestRegular.funding_time) : "No settlement in window"}</div></div>
      </section>

      <section className="panel detail-chart-panel"><div className="panel-heading"><div><div className="section-kicker">FUNDING OVER {range} DAYS</div><h2>Cumulative funding</h2><p>Actual funding rates added when Binance settled them, including special events.</p></div><div className="chart-key"><span className="key-dot" /> {formatPct(events.length ? cumulative : null, 2)}</div></div>{events.length ? <FinancialChart series={cumulativeSeries} height={280} /> : <div className="empty-chart">No funding settlements in this window.</div>}<div className="chart-caption">Positive values mean funding was received by a short perpetual position before fees.</div></section>

      <section className="panel detail-chart-panel"><div className="panel-heading"><div><div className="section-kicker">PRICE PERFORMANCE</div><h2>Perpetual vs. spot</h2><p>Percentage change from the first {stock.spot_symbol ? "matched hourly close" : "perpetual hourly close"} in this window.</p></div><div className="legend"><span><i className="legend-perp" /> Perpetual</span>{stock.spot_symbol && <span><i className="legend-spot" /> bStock spot</span>}</div></div>{priceSeries.length && priceSeries.some((series) => series.points.length) ? <FinancialChart series={priceSeries} height={330} /> : <div className="empty-chart">Hourly price history is unavailable.</div>}<div className="chart-caption">Completed UTC hourly candles · gaps mean no source candle was available</div></section>

      <div className="detail-two-col"><section className="panel detail-chart-panel"><div className="panel-heading"><div><div className="section-kicker">SETTLED PAYMENTS</div><h2>Funding event rates</h2><p>Each bar is a UTC hour with one or more actual settlements.</p></div><div className="chart-key"><span className="key-dot" /> {events.length} events</div></div>{events.length ? <FinancialChart series={fundingSeries} height={260} histogram /> : <div className="empty-chart">No funding settlements in this window.</div>}<div className="chart-caption">Above zero: short receives · below zero: short pays · gray: includes a special event</div></section>
      <section className="panel detail-chart-panel"><div className="panel-heading"><div><div className="section-kicker">PRICE DIVERGENCE</div><h2>Hourly perp / spot gap</h2><p>(Perpetual close ÷ spot close − 1) × 100</p></div><div className="chart-key"><span className="key-dot" /> {pairs.length} matched hours</div></div>{stock.spot_symbol && pairs.length ? <FinancialChart series={basisSeries} height={260} /> : <div className="empty-chart">A matching bStock spot pair is unavailable.</div>}<div className="chart-caption">Latest {formatPct(latestBasis, 2)} · average {formatPct(meanBasis, 2)} in this window · completed UTC hours only</div></section></div>

      <section className="panel events-panel"><div className="market-heading"><div><div className="section-kicker">EVENT LOG</div><h2>Recent funding payments</h2><p>{specialCount ? `${specialCount} special dividend-related event${specialCount === 1 ? "" : "s"} in this window.` : "Regular and special funding events are identified separately."}</p></div><span className="events-count">{events.length} EVENTS</span></div><div className="table-wrap"><table><thead><tr><th>SETTLEMENT TIME</th><th>TYPE</th><th>FUNDING RATE</th><th>SHORT SIDE</th></tr></thead><tbody>{[...events].reverse().slice(0, 12).map((event) => <tr key={`${event.funding_time}-${event.rate_type}`}><td>{formatUtc(event.funding_time)}</td><td><span className={`event-tag ${event.rate_type === "Special" ? "special-tag" : ""}`}>{event.rate_type}</span></td><td className={`number-cell ${signedClass(event.funding_rate)}`}>{formatPct(event.funding_rate * 100, 4)}</td><td className={signedClass(event.funding_rate)}>{event.funding_rate > 0 ? <span className="direction"><ArrowUpRight size={15} /> Receives</span> : event.funding_rate < 0 ? <span className="direction"><ArrowDownRight size={15} /> Pays</span> : <span className="direction">No transfer</span>}</td></tr>)}</tbody></table>{events.length === 0 && <div className="table-empty">No funding events in this window.</div>}</div></section>

      <div className="detail-note"><Info size={17} /><span>Estimated APY compounds actual event rates from the selected window and assumes that pace repeats for a year. It is hypothetical, unlevered, and excludes fees, financing, and slippage. Cumulative funding is the simple sum of those rates.</span></div>
    </>}
  </main><PageFooter /></div>;
}
