"use client";

import { Activity, ArrowDownRight, ArrowUpRight, BarChart3, Clock3, Coins, Info, Layers3 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { alignHourlyPrices, cumulativeFunding, fundingInWindow } from "@/lib/analytics";
import { fetchFunding, fetchLatestRun, fetchOpenInterest, fetchPrices, fetchStock } from "@/lib/data";
import { DAY_MS, HOUR_MS } from "@/lib/market";
import { summarizeFunding } from "@/lib/strategy";
import { FinancialChart, type ChartSeries } from "./financial-chart";
import { FormulaHint } from "./formula-hint";
import { StrategySimulator } from "./strategy-simulator";
import { AppHeader, BackLink, DataMessage, formatCompact, formatPct, formatUtc, LoadingIndicator, PageFooter, signedClass } from "./ui";

const HISTORY_DAYS = 30;

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
  const [viewNow] = useState(() => Date.now());
  const stockQuery = useQuery({ queryKey: ["stock", ticker], queryFn: () => fetchStock(ticker) });
  const runQuery = useQuery({ queryKey: ["latest-run"], queryFn: fetchLatestRun });
  const stock = stockQuery.data;
  const run = runQuery.data;
  const through = run?.data_through ?? "";
  const fundingQuery = useQuery({ queryKey: ["stock-funding", ticker, through], queryFn: () => fetchFunding([ticker], through), enabled: !!through && !!stock });
  const pricesQuery = useQuery({ queryKey: ["stock-prices", ticker, through], queryFn: () => fetchPrices(ticker, through), enabled: !!through && !!stock });
  const oiQuery = useQuery({ queryKey: ["stock-oi", ticker, through], queryFn: () => fetchOpenInterest([ticker], through), enabled: !!through && !!stock });
  const endMs = through ? Date.parse(through) : 0;
  const startMs = endMs - HISTORY_DAYS * DAY_MS;
  const events = fundingInWindow(fundingQuery.data ?? [], startMs, endMs);
  const prices = (pricesQuery.data ?? []).filter((price) => Date.parse(price.bucket_start) >= startMs);
  const pairs = stock?.spot_symbol ? alignHourlyPrices(prices) : [];
  const perp = prices.filter((price) => price.market === "perp").sort((a, b) => Date.parse(a.bucket_start) - Date.parse(b.bucket_start));
  const cumulative = cumulativeFunding(events);
  const regularPace = summarizeFunding(events, endMs, HISTORY_DAYS);
  const apy = regularPace.regularCount ? regularPace.annualizedRate * 100 : null;
  const latestRegular = [...events].reverse().find((event) => event.rate_type === "Regular");
  const latestPair = pairs.at(-1);
  const latestBasis = latestPair?.basis ?? null;
  const latestPriceGap = latestPair ? latestPair.perp - latestPair.spot : null;
  const meanBasis = pairs.length ? pairs.reduce((sum, point) => sum + point.basis, 0) / pairs.length : null;
  const specialCount = events.filter((event) => event.rate_type === "Special").length;
  const openInterest = (oiQuery.data ?? []).filter((row) => Date.parse(row.bucket_start) >= startMs);
  const oiSeries: ChartSeries[] = [{ name: "Open interest in millions of USDT", color: "#80d3e3", points: withHourlyGaps(openInterest.map((row) => ({ time: Date.parse(row.bucket_start), value: row.open_interest_value / 1_000_000 }))) }];
  const basisByHour = new Map(pairs.map((point) => [point.time, point.basis]));
  const worstWidening = pairs.reduce<number | null>((worst, point) => {
    const previous = basisByHour.get(point.time - DAY_MS);
    return previous == null ? worst : Math.max(worst ?? 0, point.basis - previous);
  }, null);

  const priceBasisSeries: ChartSeries[] = pairs.length ? [
    { name: "bStock spot close on left USDT axis", color: "#c7f36b", axis: "left", format: "price", points: withHourlyGaps(pairs.map((point) => ({ time: point.time, value: point.spot }))) },
    { name: "perpetual minus spot basis on right percent axis", color: "#80d3e3", axis: "right", format: "percent", points: withHourlyGaps(pairs.map((point) => ({ time: point.time, value: point.basis }))) },
  ] : !stock?.spot_symbol && perp.length ? [
    { name: "Perpetual close on left USDT axis", color: "#c7f36b", axis: "left", format: "price", points: withHourlyGaps(perp.map((price) => ({ time: Date.parse(price.bucket_start), value: price.close }))) },
  ] : [];
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
  const cumulativeSeries: ChartSeries[] = [{ name: "Cumulative funding", color: "#c7f36b", format: "percent", steps: true, points: cumulativePoints }];
  const fundingSeries: ChartSeries[] = (() => {
    const byHour = new Map<number, { value: number; special: boolean }>();
    for (const event of events) {
      const hour = Math.floor(Date.parse(event.funding_time) / HOUR_MS) * HOUR_MS;
      const entry = byHour.get(hour) ?? { value: 0, special: false };
      entry.value += event.funding_rate * 100;
      entry.special ||= event.rate_type === "Special";
      byHour.set(hour, entry);
    }
    return [{ name: "Funding payments", color: "#c7f36b", format: "percent", points: [...byHour].sort((a, b) => a[0] - b[0]).map(([time, entry]) => ({ time, value: entry.value, color: entry.special ? "#f4c477" : entry.value >= 0 ? "#c7f36b" : "#ff98a3" })) }];
  })();

  const loading = stockQuery.isLoading || runQuery.isLoading || fundingQuery.isLoading || pricesQuery.isLoading;
  const error = stockQuery.error ?? runQuery.error ?? fundingQuery.error ?? pricesQuery.error;
  const needsMigration = error?.message.includes("Could not find the table");
  const oiNeedsMigration = oiQuery.error?.message.includes("Could not find the table");
  const loadingLabel = stockQuery.isLoading || runQuery.isLoading ? "Loading stock and sync status…"
    : fundingQuery.isLoading || pricesQuery.isLoading ? "Loading and calculating funding and price history…"
      : oiQuery.isLoading ? "Loading open interest history…"
        : stockQuery.isFetching || runQuery.isFetching || fundingQuery.isFetching || pricesQuery.isFetching || oiQuery.isFetching ? "Refreshing stock history and charts…"
          : null;
  return <div className="site-shell"><AppHeader ticker={ticker} /><main className="main-container detail-container">
    <BackLink />
    {loadingLabel && <LoadingIndicator label={loadingLabel} />}
    {error && !needsMigration && <div className="error-banner">Data request failed: {error.message}</div>}
    {oiNeedsMigration && <div className="error-banner">Open interest history is pending. Apply the new Supabase migration; funding, prices, and live quotes remain available.</div>}
    {oiQuery.error && !oiNeedsMigration && <div className="error-banner">Open interest history request failed: {oiQuery.error.message}</div>}
    {needsMigration && <DataMessage title="No market data yet">Apply the Supabase migration and run <code>bun run sync</code> to load this stock.</DataMessage>}
    {!loading && !stock && !error && <DataMessage title="Stock not found">This ticker is not in the current tracked universe.</DataMessage>}
    {stock && <>
      <div className="detail-heading"><div className="detail-heading-left"><span className="detail-avatar">{ticker.slice(0, 2)}</span><div><div className="eyebrow"><span className="eyebrow-line" /> STOCK PERPETUAL / RANK #{stock.rank}</div><h1>{ticker}<span className="accent-period">.</span></h1><p>{stock.perp_symbol} perpetual {stock.spot_symbol ? <>· {stock.spot_symbol} spot</> : "· No matching Binance bStock pair"}</p></div></div></div>

      <div className="detail-status"><span className="pair-tag"><span /> {stock.perp_symbol}</span>{stock.spot_symbol ? <span className="pair-tag spot-pair"><span /> {stock.spot_symbol}</span> : <span className="no-pair">Funding only</span>}<span className="detail-volume">24h perp volume ${formatCompact(stock.quote_volume_24h)}</span><span className="detail-status-right"><Clock3 size={14} /> Data through {formatUtc(through)}{run?.finished_at && viewNow - Date.parse(run.finished_at) >= DAY_MS && " · stale"}</span></div>

      <StrategySimulator stocks={[stock]} funding={fundingQuery.data ?? []} openInterest={oiQuery.data ?? []} through={through} finishedAt={run?.finished_at} mode="detail" />

      <section className="stat-grid detail-stats" aria-label={`${ticker} summary`}>
        <div className="stat-card stat-card-primary"><div className="stat-label"><span>{HISTORY_DAYS}D CUMULATIVE FUNDING <FormulaHint label="Cumulative funding" formula="Sum of every actual funding event rate in the last 30 days × 100%." note="Includes regular and special events. A positive value means a short perpetual position received funding before fees." /></span><Coins size={17} /></div><div className={`stat-value ${signedClass(events.length ? cumulative : null)}`}>{formatPct(events.length ? cumulative : null, 2)}</div><div className="stat-foot">{events.length} actual payments · short side · before fees</div></div>
        <div className="stat-card"><div className="stat-label"><span>REGULAR FUNDING PACE <FormulaHint label="Regular funding pace" formula="(Sum of regular funding rates ÷ observed days) × 365 × 100%." note="Simple annualization, with no compounding. Special events are excluded." /></span><Activity size={17} /></div><div className={`stat-value ${signedClass(apy)}`}>{formatPct(apy, 1)}</div><div className="stat-foot">Simple annualized · excludes special events</div></div>
        <div className="stat-card"><div className="stat-label"><span>LATEST PERP / SPOT GAP <FormulaHint label="Latest price basis" formula="(Latest matched perpetual hourly close ÷ spot hourly close − 1) × 100%. The USDT gap is perpetual close − spot close." note="Both completed candles must belong to the same UTC hour. A positive basis means the perpetual is above spot." /></span><BarChart3 size={17} /></div><div className="stat-value basis-value">{formatPct(stock.spot_symbol ? latestBasis : null, 2)}</div><div className="stat-foot">{latestPriceGap == null ? "No matched hourly close" : `${latestPriceGap >= 0 ? "+" : "−"}$${Math.abs(latestPriceGap).toFixed(2)} USDT · ${formatUtc(latestPair?.time)}`}</div></div>
        <div className="stat-card"><div className="stat-label"><span>LATEST REGULAR FUNDING <FormulaHint label="Latest regular funding" formula="The exact rate of the most recent Binance settlement marked Regular in this window × 100%." note="This is a source event, not a projected future funding rate. Positive means the short received funding." /></span><Layers3 size={17} /></div><div className={`stat-value ${signedClass(latestRegular?.funding_rate)}`}>{formatPct(latestRegular ? latestRegular.funding_rate * 100 : null)}</div><div className="stat-foot">{latestRegular ? formatUtc(latestRegular.funding_time) : "No settlement in window"}</div></div>
      </section>

      <section className="panel risk-panel"><div className="panel-heading"><div><div className="section-kicker">CAPITAL AND BASIS RISK</div><h2>Open interest and basis stress</h2><p>OI is the total value of outstanding perpetual positions; first sync can backfill about one month.</p></div><div className="chart-key">Worst observed 24h basis widening: {formatPct(worstWidening, 2)} <FormulaHint label="Worst 24-hour basis widening" formula="For each matched hour with a matched hour 24 hours earlier: current basis − basis 24 hours earlier. Show the largest positive change." note="A gap with no 24-hour comparison is omitted. Basis = (perpetual close ÷ spot close − 1) × 100%." /></div></div><div className="chart-axis-label">Y AXIS · OPEN INTEREST (MILLIONS OF USDT) <FormulaHint label="Historical open interest value" formula="Binance hourly open-interest value in USDT ÷ 1,000,000." note="Only completed hourly observations are charted; missing hours remain gaps." /></div>{openInterest.length ? <FinancialChart series={oiSeries} height={230} /> : <div className="empty-chart">Hourly open interest will appear after an OI sync.</div>}<div className="chart-caption">An axis value of 100 means about 100 million USDT of outstanding perp notional. OI snapshots use completed UTC hours.</div></section>

      <section className="panel detail-chart-panel"><div className="panel-heading"><div><div className="section-kicker">FUNDING OVER {HISTORY_DAYS} DAYS</div><h2>Cumulative funding <FormulaHint label="Cumulative funding chart" formula="At each actual settlement: previous cumulative value + settled funding rate × 100%." note="Includes regular and special events. There is no invented payment for an hour with no settlement." /></h2><p>Actual funding rates added when Binance settled them, including special events.</p></div><div className="chart-key"><span className="key-dot" /> {formatPct(events.length ? cumulative : null, 2)}</div></div>{events.length ? <FinancialChart series={cumulativeSeries} height={280} /> : <div className="empty-chart">No funding settlements in this window.</div>}<div className="chart-caption">Positive values mean funding was received by a short perpetual position before fees.</div></section>

      <section className="panel detail-chart-panel price-basis-panel"><div className="panel-heading"><div><div className="section-kicker">HOURLY PRICE AND BASIS</div><h2>{stock.spot_symbol ? "Spot price and perp–spot basis" : "Perpetual price"} <FormulaHint label="Hourly spot and perpetual basis" formula="Left axis: bStock spot hourly close in USDT. Right axis: (perpetual hourly close ÷ spot hourly close − 1) × 100%." note="Both candles must share a completed UTC hour. Missing hours remain gaps; a positive basis means the perpetual closed above spot." /></h2><p>{stock.spot_symbol ? "One time axis, with spot price on the left and the perpetual premium on the right." : "No matching bStock spot pair exists, so only the perpetual hourly close is shown."}</p></div><div className="legend"><span><i className="legend-spot-price" /> {stock.spot_symbol ? "bStock spot · left USDT" : "Perpetual · left USDT"}</span>{stock.spot_symbol && <span><i className="legend-basis" /> Perp − spot basis · right %</span>}</div></div><div className="dual-axis-labels"><span>LEFT Y · {stock.spot_symbol ? "SPOT" : "PERP"} CLOSE (USDT)</span>{stock.spot_symbol && <span>RIGHT Y · (PERP ÷ SPOT − 1) × 100%</span>}</div>{priceBasisSeries.length ? <FinancialChart series={priceBasisSeries} height={340} /> : <div className="empty-chart">Hourly price history is unavailable.</div>}<div className="chart-caption">Completed UTC hourly candles · {pairs.length} matched hours · latest basis {formatPct(latestBasis, 3)} · average {formatPct(meanBasis, 3)} <FormulaHint label="Average hourly basis" formula="Sum of matched-hour basis values ÷ number of matched hours." note="Each matched UTC hour has equal weight. Basis = (perpetual close ÷ spot close − 1) × 100%." /> · missing hours remain gaps</div></section>

      <section className="panel detail-chart-panel"><div className="panel-heading"><div><div className="section-kicker">SETTLED PAYMENTS</div><h2>Funding event rates <FormulaHint label="Hourly funding event rate" formula="Sum of actual funding event rates settled within the UTC hour × 100%." note="An hour without a settlement has no bar. Bars including a special event use the amber color." /></h2><p>Each bar is a UTC hour with one or more actual settlements.</p></div><div className="chart-key"><span className="key-dot" /> {events.length} events</div></div>{events.length ? <FinancialChart series={fundingSeries} height={260} histogram /> : <div className="empty-chart">No funding settlements in this window.</div>}<div className="chart-caption">Above zero: short receives · below zero: short pays · amber: includes a special event</div></section>

      <section className="panel events-panel"><div className="market-heading"><div><div className="section-kicker">EVENT LOG</div><h2>Recent funding payments</h2><p>{specialCount ? `${specialCount} special dividend-related event${specialCount === 1 ? "" : "s"} in this window.` : "Regular and special funding events are identified separately."}</p></div><span className="events-count">{events.length} EVENTS</span></div><div className="table-wrap"><table><thead><tr><th>SETTLEMENT TIME</th><th>TYPE</th><th>FUNDING RATE <FormulaHint label="Settled funding rate" formula="Exact settled Binance funding rate × 100% for display." note="Positive means the short received this payment; negative means the short paid it. The rate type is preserved from the source." /></th><th>SHORT SIDE</th></tr></thead><tbody>{[...events].reverse().slice(0, 12).map((event) => <tr key={`${event.funding_time}-${event.rate_type}`}><td>{formatUtc(event.funding_time)}</td><td><span className={`event-tag ${event.rate_type === "Special" ? "special-tag" : ""}`}>{event.rate_type}</span></td><td className={`number-cell ${signedClass(event.funding_rate)}`}>{formatPct(event.funding_rate * 100, 4)}</td><td className={signedClass(event.funding_rate)}>{event.funding_rate > 0 ? <span className="direction"><ArrowUpRight size={15} /> Receives</span> : event.funding_rate < 0 ? <span className="direction"><ArrowDownRight size={15} /> Pays</span> : <span className="direction">No transfer</span>}</td></tr>)}</tbody></table>{events.length === 0 && <div className="table-empty">No funding events in this window.</div>}</div></section>

      <div className="detail-note"><Info size={17} /><span>Summary cards and charts show the last {HISTORY_DAYS} days. The simulator separately compares 7-, 30-, and 90-day funding history and uses the 30-day regular pace for its main projection.</span></div>
    </>}
  </main><PageFooter /></div>;
}
