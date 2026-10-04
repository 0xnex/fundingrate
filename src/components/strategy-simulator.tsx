"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { FundingEvent } from "@/lib/analytics";
import { fetchMarketSnapshots, type OpenInterestRow, type TrackedStock } from "@/lib/data";
import { fetchMarketSnapshot } from "@/lib/live-market";
import { DAY_MS } from "@/lib/market";
import { DEFAULT_STRATEGY_INPUTS, estimateHistoricalPreview, marketIsFresh, rankOpportunities, simulateOpportunity, summarizeFunding, type MarketSnapshot, type StrategyInputs } from "@/lib/strategy";
import { OrderbookDepth } from "./orderbook-depth";
import { FormulaHint } from "./formula-hint";
import { formatCompact, formatPct, formatUtc, signedClass } from "./ui";

function money(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) ? "—" : `${value < 0 ? "−" : ""}$${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

function price(value: number) {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: value < 1 ? 6 : 4 })}`;
}

function share(value: number | null | undefined, digits = 1) {
  return value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(digits)}%`;
}

function metricLabel(label: string, formula: string, note?: string) {
  return <>{label} <FormulaHint label={label} formula={formula} note={note} /></>;
}

function oiChange(rows: OpenInterestRow[], ticker: string, nowMs: number, currentValue: number | null) {
  if (currentValue == null) return null;
  const target = nowMs - DAY_MS;
  const previous = rows.filter((row) => row.ticker === ticker && Date.parse(row.bucket_start) <= target && Date.parse(row.bucket_start) >= target - 6 * 60 * 60 * 1000).at(-1);
  return previous && previous.open_interest_value > 0 ? (currentValue / previous.open_interest_value - 1) * 100 : null;
}

export function StrategySimulator({ stocks, funding, openInterest, through, finishedAt, mode = "overview" }: {
  stocks: TrackedStock[];
  funding: FundingEvent[];
  openInterest: OpenInterestRow[];
  through: string;
  finishedAt: string | null | undefined;
  mode?: "overview" | "detail";
}) {
  const [inputs, setInputs] = useState<StrategyInputs>(DEFAULT_STRATEGY_INPUTS);
  const [clockMs, setClockMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClockMs(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const tickers = stocks.map((stock) => stock.ticker);
  const live = useQuery({
    queryKey: ["market-snapshots", mode, tickers.join(",")],
    queryFn: async () => {
      if (mode === "detail" && stocks[0]) {
        const direct: MarketSnapshot = { ...await fetchMarketSnapshot(stocks[0], fetch, 500), source: "browser" };
        if (marketIsFresh(direct, Date.now())) return [direct];
        try {
          const backup = (await fetchMarketSnapshots(tickers))[0];
          if (backup && marketIsFresh(backup, Date.now())) return [{ ...backup, source: "server" as const }];
        } catch { /* Keep the direct result so the page can show its failure reason. */ }
        return [direct];
      }
      return (await fetchMarketSnapshots(tickers)).map((market) => ({ ...market, source: "server" as const }));
    },
    enabled: tickers.length > 0,
    staleTime: mode === "detail" ? 8_000 : 25_000,
    refetchInterval: mode === "detail" ? 10_000 : 30_000,
    retry: 1,
  });
  const latestFetchMs = Math.max(0, ...(live.data ?? []).map((item) => Date.parse(item.fetchedAt)).filter(Number.isFinite));
  const nowMs = Math.max(clockMs, latestFetchMs);
  const marketByTicker = useMemo(() => new Map((live.data ?? []).map((item) => [item.ticker, item])), [live.data]);
  const endMs = through ? Date.parse(through) : 0;
  const syncFresh = !!finishedAt && nowMs - Date.parse(finishedAt) <= DAY_MS;
  const opportunities = useMemo(() => {
    if (!syncFresh || !endMs) return [];
    const byTicker = new Map<string, FundingEvent[]>();
    for (const event of funding) byTicker.set(event.ticker, [...(byTicker.get(event.ticker) ?? []), event]);
    return rankOpportunities(stocks.flatMap((stock) => {
      const market = marketByTicker.get(stock.ticker);
      if (!stock.spot_symbol || !market) return [];
      const result = simulateOpportunity(market, byTicker.get(stock.ticker) ?? [], endMs, inputs, nowMs);
      return result ? [result] : [];
    }));
  }, [stocks, funding, marketByTicker, endMs, inputs, nowMs, syncFresh]);
  const recommended = opportunities[0]?.netProfit > 0 ? opportunities[0] : null;
  const detailOpportunity = opportunities.find((item) => item.ticker === stocks[0]?.ticker);
  const selected = mode === "detail" ? (detailOpportunity && detailOpportunity.netProfit > 0 ? detailOpportunity : null) : recommended;
  const selectedMarket: MarketSnapshot | undefined = marketByTicker.get((mode === "detail" ? stocks[0]?.ticker : recommended?.ticker) ?? "");
  const fundingWindows = mode === "detail" && stocks[0] && endMs ? [7, 30, 90].map((days) => summarizeFunding(funding, endMs, days)) : [];
  const detailMarket = mode === "detail" ? marketByTicker.get(stocks[0]?.ticker ?? "") : null;

  function update(field: keyof StrategyInputs, value: string) {
    setInputs((previous) => ({ ...previous, [field]: value === "" ? Number.NaN : Number(value) }));
  }
  const invalid = !(inputs.budget > 0 && Number.isFinite(inputs.budget) && Number.isInteger(inputs.days) && inputs.days >= 1 && inputs.days <= 365
    && inputs.shockPct >= 0 && inputs.shockPct < 100 && inputs.reservePct >= 0 && inputs.reservePct < 100
    && inputs.spotFeePct >= 0 && inputs.perpFeePct >= 0 && inputs.carryingPctAnnual >= 0);
  const thirtyDayFunding = fundingWindows.find((window) => window.days === 30);
  const historicalPreview = mode === "detail" && !selected && stocks[0]?.spot_symbol && thirtyDayFunding && thirtyDayFunding.observedDays >= 7
    ? estimateHistoricalPreview(inputs, thirtyDayFunding.dailyRate) : null;
  const projectedNotional = selected?.perpNotional ?? historicalPreview?.notional ?? null;
  const fundingProjections = fundingWindows.map((window) => {
    const enoughHistory = window.regularCount > 0 && window.observedDays >= (window.days === 7 ? 5 : 7);
    const gross = projectedNotional != null && enoughHistory && !invalid ? projectedNotional * window.dailyRate * inputs.days : null;
    const net = gross == null ? null : selected
      ? gross - selected.totalFees - selected.executionCost - selected.carryingCost
      : historicalPreview ? gross - historicalPreview.fees - historicalPreview.carryingCost : null;
    return { ...window, gross, net };
  });
  const basisWideningPerPoint = selected ? selected.netProfit - selected.widerBasisProfit : 0;
  const fullHoldBasisTolerance = selected && basisWideningPerPoint > 0 ? selected.netProfit / basisWideningPerPoint : null;
  const grossFundingPct = !invalid && thirtyDayFunding && thirtyDayFunding.observedDays >= 7
    ? thirtyDayFunding.dailyRate * inputs.days * 100 : null;
  const feeHurdlePct = 2 * (inputs.spotFeePct + inputs.perpFeePct);
  const fundingBelowFees = grossFundingPct !== null && grossFundingPct <= feeHurdlePct;
  const feeOnlyBreakEven = !invalid && thirtyDayFunding && thirtyDayFunding.dailyRate > 0
    ? feeHurdlePct / (thirtyDayFunding.dailyRate * 100) : null;
  const sevenDayFunding = fundingWindows.find((window) => window.days === 7);
  const recentPaceNet = selected && sevenDayFunding && sevenDayFunding.regularCount >= 14 && sevenDayFunding.observedDays >= 5
    ? selected.netProfit + selected.perpNotional * (sevenDayFunding.dailyRate - selected.funding.dailyRate) * inputs.days : null;
  const pairReady = !!stocks[0]?.spot_symbol;
  const historyReady = syncFresh && !!thirtyDayFunding && thirtyDayFunding.observedDays >= 7;
  const liveReady = !!detailMarket && marketIsFresh(detailMarket, nowMs);
  const netPrerequisitesReady = !invalid && pairReady && historyReady && liveReady;
  const positiveNet = netPrerequisitesReady && !!detailOpportunity && detailOpportunity.netProfit > 0;
  const weakRecentPace = positiveNet && recentPaceNet !== null && recentPaceNet <= 0;
  const liveFailureReason = detailMarket?.error?.includes("HTTP 451")
    ? `Binance restricted futures data from ${detailMarket.source === "browser" ? "your browser's network" : "the server region"} (HTTP 451).`
    : detailMarket?.error ? `Binance live data failed: ${detailMarket.error}.`
      : live.error ? `Live market request failed: ${live.error.message}.`
        : "A required live quote or order book is unavailable.";
  let netState: "ready" | "blocked" | "pending" = "pending";
  let netValue = "Awaiting required data";
  if (netPrerequisitesReady) {
    netState = positiveNet ? weakRecentPace ? "pending" : "ready" : "blocked";
    netValue = positiveNet && detailOpportunity
      ? `${money(detailOpportunity.netProfit)} base${weakRecentPace ? " · recent pace loses" : ""}`
      : "No positive modeled trade";
  }
  const decisionChecks = [
    { label: "SPOT PAIR", state: pairReady ? "ready" : "blocked", value: pairReady ? stocks[0].spot_symbol! : "Unavailable" },
    { label: "FUNDING HISTORY", state: historyReady ? "ready" : "blocked", value: historyReady ? `${thirtyDayFunding.regularCount} regular events · sync current` : "Stale or insufficient" },
    { label: "LIVE BOOKS", state: liveReady ? "ready" : live.isLoading ? "pending" : "blocked", value: liveReady ? "Fresh · both sides available" : live.isLoading ? "Checking" : "Missing or over 60 seconds old" },
    { label: "NET RESULT", state: netState, value: netValue },
  ] as const;
  let detailVerdict = { title: "Checking current quotes", reason: "Waiting for fresh order books and funding data." };
  if (invalid) detailVerdict = { title: "Enter valid inputs", reason: "A decision needs a positive cash budget, whole holding days, and valid assumptions." };
  else if (!syncFresh) detailVerdict = { title: "Decision unavailable", reason: "The historical sync is over 24 hours old. Refresh the stored data before assessing this trade." };
  else if (!stocks[0]?.spot_symbol) detailVerdict = { title: "Not eligible", reason: "There is no matching bStock spot pair to buy against this perpetual." };
  else if (selected) detailVerdict = recentPaceNet !== null && recentPaceNet <= 0
    ? { title: "Positive model, weak recent pace", reason: `The 30-day funding pace projects ${money(selected.netProfit)} net, but repeating the last seven days' pace would project ${money(recentPaceNet)} over this hold. Funding and exit prices can change.` }
    : { title: "Potential candidate", reason: `The unchanged-basis model projects ${money(selected.netProfit)} over ${inputs.days} days after estimated fees and execution costs. Funding and exit prices can change.` };
  else if (!live.isLoading && (live.error || detailMarket?.error)) detailVerdict = fundingBelowFees
    ? { title: "No funding edge at this horizon", reason: `Recent regular funding would not cover the assumed four taker fees. ${liveFailureReason} Live execution remains unverified.` }
    : { title: "Cannot assess execution now", reason: `${liveFailureReason} No executable net profit can be confirmed.` };
  else if (!live.isLoading) detailVerdict = fundingBelowFees
    ? { title: "Pass under these assumptions", reason: "Recent regular funding would not cover the assumed four taker fees, before spread, slippage, and carrying costs. No positive unchanged-basis position is modeled." }
    : { title: "No positive modeled trade", reason: "The current books, budget, funding history, and stress reserve do not produce positive net profit under an unchanged exit basis." };
  const verdictTone = selected ? weakRecentPace ? "caution" : "favorable"
    : live.isLoading ? "neutral"
      : live.error || detailMarket?.error || !pairReady || !historyReady ? "unavailable" : "caution";

  return <section className="panel simulator-panel" aria-label="Funding strategy simulator">
    <div className="sim-heading"><div><div className="section-kicker">{mode === "detail" ? "TRADE DECISION" : "STRATEGY SIMULATOR"}</div><h2>{mode === "overview" ? "Find a matched trade" : `Can ${stocks[0]?.ticker ?? "this stock"} work?`}</h2><p>Buy bStock spot, short an equal quantity of the perpetual. Results are scenarios, not settled returns.</p></div><span className="sim-status" role="status">{live.isFetching && <span className="loading-spinner" aria-hidden="true" />}{live.isFetching ? "Refreshing quotes" : live.data?.some((market) => market.perpBook && market.spotBook) ? `Quotes ${formatUtc(live.data[0]?.fetchedAt)}` : live.data ? "Live books unavailable" : "Waiting for quotes"}</span></div>
    <div className="sim-inputs">
      <label>Cash budget (USDT)<input type="number" min="1" step="100" value={Number.isNaN(inputs.budget) ? "" : inputs.budget} onChange={(event) => update("budget", event.target.value)} /></label>
      <label>Holding days<input type="number" min="1" max="365" step="1" value={Number.isNaN(inputs.days) ? "" : inputs.days} onChange={(event) => update("days", event.target.value)} /></label>
      <details className="sim-advanced"><summary>Advanced assumptions</summary><div className="sim-advanced-grid">
        <label>Adverse perp rise (%)<input type="number" min="0" max="99" step="1" value={Number.isNaN(inputs.shockPct) ? "" : inputs.shockPct} onChange={(event) => update("shockPct", event.target.value)} /></label>
        <label>Prefunded reserve (%)<input type="number" min="0" max="99" step="1" value={Number.isNaN(inputs.reservePct) ? "" : inputs.reservePct} onChange={(event) => update("reservePct", event.target.value)} /></label>
        <label>Spot taker fee / leg (%)<input type="number" min="0" step="0.01" value={Number.isNaN(inputs.spotFeePct) ? "" : inputs.spotFeePct} onChange={(event) => update("spotFeePct", event.target.value)} /></label>
        <label>Perp taker fee / leg (%)<input type="number" min="0" step="0.01" value={Number.isNaN(inputs.perpFeePct) ? "" : inputs.perpFeePct} onChange={(event) => update("perpFeePct", event.target.value)} /></label>
        <label>Annual carrying cost (%)<input type="number" min="0" step="0.1" value={Number.isNaN(inputs.carryingPctAnnual) ? "" : inputs.carryingPctAnnual} onChange={(event) => update("carryingPctAnnual", event.target.value)} /></label>
      </div></details>
    </div>
    {mode === "detail" && <div className={`sim-verdict sim-verdict-${verdictTone}`} role="status">
      <span>DECISION FOR {invalid ? "A VALID HOLDING PERIOD" : `${inputs.days} DAYS · ${money(inputs.budget)} CASH`}</span>
      <strong>{detailVerdict.title}</strong>
      <p>{detailVerdict.reason}</p>
      <ul className="sim-decision-checks">{decisionChecks.map((check) => <li key={check.label}><span className={`sim-check-state sim-check-${check.state}`} aria-hidden="true" /><div><small>{check.label}</small><b>{check.value}</b></div></li>)}</ul>
      {grossFundingPct !== null && <div className="sim-verdict-math">
        <span>{metricLabel("Gross funding at 30-day pace", "Regular funding rates settled over 30 days ÷ observed days × holding days × 100%. This is a percentage of matched perpetual notional.")} <b>{formatPct(grossFundingPct, 2)}</b> of position notional</span>
        <span>{metricLabel("Assumed four taker fees", "2 × (spot taker fee per leg + perpetual taker fee per leg). The actual dollar fee uses each of the four book-filled notionals.")} <b>{formatPct(feeHurdlePct, 2)}</b> approximately</span>
        <span>{metricLabel("Fee-only break-even hold", "2 × (spot fee rate + perpetual fee rate) ÷ 30-day regular funding rate per day. This ignores spread, slippage, and carrying cost.")} <b>{feeOnlyBreakEven === null ? "Unavailable" : `${feeOnlyBreakEven.toFixed(1)} days`}</b> at that pace</span>
        {sevenDayFunding && <span>{metricLabel("Recent seven-day pace", "Sum of settled regular funding rates in the last seven days ÷ observed days × 100%. Special events excluded.")} <b>{formatPct(sevenDayFunding.dailyRate * 100, 4)} / day</b> over 7 days</span>}
      </div>}
      {recentPaceNet !== null && <div className="sim-recent-scenario">{metricLabel("Net at recent seven-day funding pace", "30-day modeled net + perpetual notional × (seven-day regular rate per day − 30-day regular rate per day) × holding days.")} <strong className={signedClass(recentPaceNet)}>{money(recentPaceNet)} modeled net</strong></div>}
      <p className="sim-verdict-note">The chart control changes historical charts below. The main trade model uses the settled 30-day regular pace; the comparison below shows all three windows for your entered budget and holding days.</p>
    </div>}
    {mode === "detail" && <OrderbookDepth market={detailMarket} spotSymbol={stocks[0]?.spot_symbol ?? null} perpSymbol={stocks[0]?.perp_symbol ?? ""} targetNotional={projectedNotional ?? inputs.budget} modeledSize={projectedNotional !== null} fetching={live.isFetching} nowMs={nowMs} />}
    {historicalPreview && <div className="sim-preview" aria-label="Historical funding illustration">
      <div className="sim-preview-head"><div><span className="sim-caption">HISTORICAL FUNDING ILLUSTRATION · EXECUTION UNVERIFIED</span><h3>{inputs.days}-day estimate for {money(inputs.budget)} cash <FormulaHint label="Historical-only net illustration" formula="30-day regular funding per observed day × illustrative perpetual notional × holding days − assumed four fees − carrying cost." note="It excludes live spread, slippage, and basis changes; it is not an executable profit estimate." /></h3></div><strong className={signedClass(historicalPreview.netBeforeExecution)}>{money(historicalPreview.netBeforeExecution)}</strong></div>
      <p>Funding minus assumed fees and carry, before spread, slippage, or a change in the spot/perp gap. This is not an executable profit or trade recommendation{!syncFresh ? "; the historical sync is stale" : ""}.</p>
      <div className="sim-preview-grid"><span>{metricLabel("Illustrative matched notional", "Minimum of the cash-budget cap and adverse-shock cap at the chosen integer leverage, assuming equal spot/perp prices and no book costs.")} <b>{money(historicalPreview.notional)}</b></span><span>{metricLabel("Regular funding at 30-day pace", "Illustrative perpetual notional × 30-day regular funding rate per observed day × holding days.")} <b>{money(historicalPreview.grossFunding)}</b></span><span>{metricLabel("Four assumed taker fees", "Illustrative notional × 2 × (spot taker fee rate + perpetual taker fee rate).") } <b>−{money(historicalPreview.fees)}</b></span><span>{metricLabel("Carrying cost", "Illustrative spot cash × entered annual carrying-cost rate × holding days ÷ 365.")} <b>−{money(historicalPreview.carryingCost)}</b></span><span>{metricLabel("Spot cash, margin and reserve", "Spot cash = illustrative matched notional. Margin = perpetual notional ÷ chosen leverage. Reserve = cash budget × entered reserve percentage.")} <b>{money(historicalPreview.spotCash)} / {money(historicalPreview.initialMargin)} / {money(historicalPreview.reserve)}</b></span><span>{metricLabel("Illustrative perpetual leverage", "Chosen integer leverage from 1× to 10× that maximizes illustrative notional while staying within cash and stress limits.")} <b>{historicalPreview.leverage}×</b></span></div>
    </div>}
    {mode === "detail" && fundingWindows.length > 0 && <div className="sim-projections"><div className="sim-projections-head"><div><span className="sim-caption">FUNDING SCENARIOS</span><h3>What could funding pay over {invalid ? "your holding period" : `${inputs.days} days`}?</h3></div><span>{projectedNotional == null ? "Position size unavailable" : `${money(projectedNotional)} matched perp notional`} <FormulaHint label="Matched perpetual notional" formula="Chosen matched share quantity × Binance perpetual mark price. The model sizes quantity within cash, reserve, depth, and adverse-move constraints." /></span></div><div className="table-wrap"><table><thead><tr><th>HISTORICAL PACE</th><th>OBSERVED <FormulaHint label="Observed funding days" formula="Elapsed UTC days from the first regular settlement in the window to the historical data cutoff, capped at the window length and floored at one day." /></th><th>REGULAR / DAY <FormulaHint label="Regular funding per day" formula="Sum of settled Regular funding rates in the window ÷ observed days × 100%. Special events excluded." /></th><th>PROJECTED FUNDING <FormulaHint label="Projected funding" formula="Matched perpetual notional × historical regular funding rate per observed day × planned holding days." /></th><th>{selected ? "NET AFTER MODELED COSTS" : "AFTER FEES + CARRY"} <FormulaHint label="Funding scenario net" formula={selected ? "Projected funding for this historical window − four modeled trading fees − round-trip book spread and slippage − carrying cost." : "Projected funding for this historical window − four assumed trading fees − carrying cost. Book execution is unavailable."} /></th></tr></thead><tbody>{fundingProjections.map((row) => <tr key={row.days}><td><strong>{row.days}D</strong>{row.days === 30 && <small> · main model</small>}</td><td>{row.observedDays.toFixed(1)} days · {row.regularCount} events</td><td className={`number-cell ${signedClass(row.regularCount ? row.dailyRate : null)}`}>{formatPct(row.regularCount ? row.dailyRate * 100 : null, 4)}</td><td className={`number-cell ${signedClass(row.gross)}`}>{money(row.gross)}</td><td className={`number-cell ${signedClass(row.net)}`}>{money(row.net)}</td></tr>)}</tbody></table></div><p>Projected funding = settled regular funding per observed day × matched perp notional × holding days. Special events are excluded. The last column includes four assumed fees and carrying cost{selected ? ", plus estimated round-trip book execution" : "; live spread and slippage are unavailable"}. A dash means the history or position size is insufficient. These are scenarios, not guaranteed payments.</p></div>}
    {invalid && <p className="sim-message">Enter a positive cash budget, 1–365 whole holding days, and valid nonnegative assumptions.</p>}
    {mode === "detail" && detailMarket && <div className="sim-quote-strip"><span>{metricLabel("Binance displayed funding", "Binance live premium-index funding rate × 100% for display. This is indicative until settlement, not a historical payment.")} <strong>{formatPct(detailMarket.fundingRate == null ? null : detailMarket.fundingRate * 100, 4)}</strong> <small>indicative · short receives if positive</small></span><span>Next settlement <strong>{formatUtc(detailMarket.nextFundingTime)}</strong></span><span>{metricLabel("Perpetual open interest value", "Current Binance open-interest contract quantity × current perpetual mark price in USDT.")} <strong>{detailMarket.openInterest != null && detailMarket.markPrice != null ? `$${formatCompact(detailMarket.openInterest * detailMarket.markPrice)}` : "—"}</strong></span><span>Quote time <strong>{formatUtc(detailMarket.quoteTime)}</strong></span></div>}
    {mode === "detail" && detailMarket?.error && <p className="sim-message">Live Binance data: {detailMarket.error}. The simulator will retry while this page is open.</p>}
    {mode === "overview" && live.data?.some((market) => market.error) && <p className="sim-message">Some live quotes are unavailable. Affected stocks are excluded until Binance data returns.</p>}
    {!invalid && !syncFresh && <p className="sim-message">Historical sync is over 24 hours old or unavailable. Run <code>bun run sync</code> before using recommendations.</p>}
    {!invalid && syncFresh && live.error && <p className="sim-message">Live market request failed: {live.error.message}</p>}
    {mode === "overview" && !invalid && syncFresh && !live.isLoading && !live.error && !selected && <p className="sim-message">{opportunities.length ? "No positive projected net profit under these assumptions." : "No pair has enough fresh funding history, current depth, and stress coverage for this budget."}</p>}
    {selected && <div className="sim-result">
      <div className="sim-result-head"><div><span className="sim-caption">{mode === "overview" ? "HIGHEST PROJECTED NET USDT PROFIT" : "MODELED POSITION"}</span><h3>{mode === "overview" ? <Link href={`/stocks/${selected.ticker}`}>{selected.ticker} <span>↗</span></Link> : selected.ticker} <small>{selected.leverage}× modeled perp leverage <FormulaHint label="Modeled perpetual leverage" formula="Perpetual notional ÷ initial futures margin. The model tests integer levels from 1× to 10× and keeps a prefunded reserve under the selected price-shock scenario." note="This is a model choice, not a Binance account setting or liquidation price." /></small></h3></div><div className="sim-profit"><div className="sim-profit-number"><strong className={signedClass(selected.netProfit)}>{money(selected.netProfit)}</strong><FormulaHint label="Projected net USDT profit" formula={`Regular funding ${money(selected.projectedFunding)} − four trading fees ${money(selected.totalFees)} − book execution cost ${money(selected.executionCost)} − carrying cost ${money(selected.carryingCost)} = ${money(selected.netProfit)}.`} note="Uses the settled 30-day regular funding pace for the entered holding period and an unchanged exit basis. Actual funding, prices, and depth can change." /></div><small>{formatPct(selected.netProfit / inputs.budget * 100, 2)} on total cash over {inputs.days} days <FormulaHint label="Return over the selected holding period" formula={`${money(selected.netProfit)} projected net ÷ ${money(inputs.budget)} total cash × 100% = ${formatPct(selected.netProfit / inputs.budget * 100, 2)}.`} note="This is a scenario for the selected holding period, not a realized return." /></small><small>{formatPct(selected.netAnnualizedPct, 1)} simple annualized on total cash <FormulaHint label="Simple annualized return on total cash" formula={`${money(selected.netProfit)} ÷ ${money(inputs.budget)} total cash × 365 ÷ ${inputs.days} holding days × 100% = ${formatPct(selected.netAnnualizedPct, 1)}.`} note="This annualization does not compound or promise a yearly result." /></small></div></div>
      <div className="sim-metrics">
        <div><span>{metricLabel("Regular funding projection", "Perpetual notional × (sum of settled regular funding rates over 30 days ÷ observed days) × holding days. Special events excluded.")}</span><strong>{money(selected.projectedFunding)}</strong></div>
        <div><span>{metricLabel("Four trading fees", "Spot taker fee rate × (spot buy notional + estimated spot sell notional) + perpetual taker fee rate × (perp sell notional + estimated perp buy notional). Exit books are assumed to resemble current books.")}</span><strong>−{money(selected.totalFees)}</strong></div>
        <div><span>{metricLabel("Round-trip spread and slippage", "(Spot buy book fill − spot sell book fill) + (perp buy book fill − perp sell book fill), all in USDT at the matched quantity. This models opening and closing at today's opposing book sides.")}</span><strong>−{money(selected.executionCost)}</strong></div>
        <div><span>{metricLabel("Carrying cost", "Spot buy notional × entered annual carrying-cost rate × holding days ÷ 365.")}</span><strong>−{money(selected.carryingCost)}</strong></div>
        <div><span>{metricLabel("Spot cash, futures margin and reserve", "Spot cash = quantity × spot ask-side VWAP. Initial futures margin = perpetual notional ÷ chosen leverage. Prefunded reserve = total cash budget × entered reserve percentage.")}</span><strong>{money(selected.spotCash)} / {money(selected.initialMargin)} / {money(selected.reserve)}</strong></div>
        <div><span>{metricLabel("Modeled adverse rise buffer", "(Initial futures margin + prefunded reserve) ÷ perpetual notional × 100% − 5 percentage points.", "A model stress buffer, not your Binance liquidation price or account margin ratio.")}</span><strong>{formatPct(selected.adverseMoveBufferPct, 1)}</strong></div>
        <div><span>{metricLabel("Break-even holding days", "(Four trading fees + round-trip book cost) ÷ (perpetual notional × 30-day regular funding rate per day − spot cash × annual carrying-cost rate ÷ 365).", "Shown only when the modeled daily funding after carry is positive.")}</span><strong>{selected.breakEvenDays == null ? "Unavailable" : `${selected.breakEvenDays.toFixed(1)} days`}</strong></div>
        <div><span>{metricLabel("Executable entry premium", "(Size-weighted perpetual sell price ÷ size-weighted spot buy price − 1) × 100%.")}</span><strong>{formatPct(selected.entryPremiumPct, 2)}</strong></div>
        <div><span>{metricLabel("Spot and perpetual spreads", "For each book: (best ask ÷ best bid − 1) × 100%.")}</span><strong>{formatPct(selected.spotSpreadPct, 2)} / {formatPct(selected.perpSpreadPct, 2)}</strong></div>
        <div><span>{metricLabel("Entry book slippage", "|Spot buy VWAP ÷ best spot ask − 1| × 100% + |Perpetual sell VWAP ÷ best perp bid − 1| × 100%.")}</span><strong>{formatPct(selected.entrySlippagePct, 2)}</strong></div>
        <div><span>{metricLabel("Available paired book depth", "Minimum of visible total quantity on each required spot and perpetual book side × spot mid price.", "The simulator also requires enough depth on all four entry and exit sides at the matched quantity.")}</span><strong>${formatCompact(selected.bookCapacity)}</strong></div>
        <div><span>{metricLabel("Current open interest and 24h change", "Current OI USDT value = Binance open-interest quantity × mark price. 24h change = (current OI value ÷ stored OI value near 24 hours ago − 1) × 100%.", "The 24-hour comparison accepts a stored observation up to six hours before the target hour; otherwise it is unavailable.")}</span><strong>{selectedMarket?.openInterest != null && selectedMarket.markPrice != null ? `$${formatCompact(selectedMarket.openInterest * selectedMarket.markPrice)}` : "—"} / {formatPct(selectedMarket?.openInterest != null && selectedMarket.markPrice != null ? oiChange(openInterest, selected.ticker, nowMs, selectedMarket.openInterest * selectedMarket.markPrice) : null, 1)}</strong></div>
        {mode === "overview" && <div><span>Binance displayed funding · indicative</span><strong>{formatPct(selectedMarket?.fundingRate == null ? null : selectedMarket.fundingRate * 100, 4)} · {formatUtc(selectedMarket?.nextFundingTime)}</strong></div>}
      </div>
      <div className="sim-scenarios"><span>{metricLabel("Exit basis unchanged", "Projected regular funding − four fees − round-trip book cost − carrying cost. The current spot/perp mid-price gap is assumed unchanged at exit.")}<strong className={signedClass(selected.netProfit)}>{money(selected.netProfit)}</strong></span><span>{metricLabel("Exit basis closes to zero", "Unchanged-basis net + (current perp mid price − current spot mid price) × matched quantity.")}<strong className={signedClass(selected.zeroBasisProfit)}>{money(selected.zeroBasisProfit)}</strong></span><span>{metricLabel("Exit basis widens one point", "Unchanged-basis net − current spot mid price × matched quantity × 1%.")}<strong className={signedClass(selected.widerBasisProfit)}>{money(selected.widerBasisProfit)}</strong></span></div>
      <p className="sim-caveat">Funding uses 30-day regular settlements. Special dividend events are historical only; bStock multipliers and corporate actions can change hedge exposure. The base case holds spot and perp mid prices and matched notional flat; exit quotes assume today’s spread and depth repeat. A 5% notional cushion is held after the selected shock; this is not Binance’s liquidation price or account margin ratio. Verify contract leverage and actual fees in Binance.</p>
    </div>}
    {mode === "detail" && <div className="sim-entry-exit"><div className="sim-caption">ENTRY AND EXIT CONDITIONS</div><h3>Price levels and reasons to reassess</h3>{selected ? <><div className="sim-entry-levels"><div><span>{metricLabel(`Buy ${stocks[0]?.spot_symbol} spot at or below`, "Walk the live spot ask levels for the matched share quantity. Spot buy VWAP = total USDT paid ÷ shares bought.")}</span><strong>{price(selected.entrySpotPrice)}</strong></div><div><span>{metricLabel(`Short ${stocks[0]?.perp_symbol} at or above`, "Walk the live perpetual bid levels for the same share quantity. Perpetual sell VWAP = total USDT received ÷ shares shorted.")}</span><strong>{price(selected.entryPerpPrice)}</strong></div><div><span>{metricLabel("Matched quantity", "Share quantity selected for the highest modeled net USDT profit across feasible integer 1×–10× leverage choices, limited by cash, reserve, four-side order-book depth, fees, and the configured adverse-price shock.")}</span><strong>{selected.quantity.toLocaleString("en-US", { maximumFractionDigits: 6 })}</strong></div></div><p>These are current size-weighted ask and bid prices from fresh books ({formatUtc(selectedMarket?.fetchedAt)}). Use them as a pre-trade limit check; a full fill at these prices is not guaranteed. Recalculate if either price, depth, or the indicative rate changes.</p></> : <p>No qualifying entry price is available. A matched spot pair, current books, sufficient history, budget and stress coverage, and positive modeled net profit are required before an entry can be assessed.</p>}<ul><li><strong>Funding reverses:</strong> Reassess at each settlement if the short starts paying or the 7-day regular pace is nonpositive{sevenDayFunding && sevenDayFunding.regularCount ? ` (currently ${formatPct(sevenDayFunding.dailyRate * 100, 4)} per day)` : ""}.</li><li><strong>Gap widens:</strong> {fullHoldBasisTolerance == null ? "Monitor the perp/spot premium against your actual entry fills and funding received." : `A rise of about ${fullHoldBasisTolerance.toFixed(2)} percentage points from the modeled baseline would consume the full-hold projected net at the 30-day pace. Recalculate with funding actually received before using this as a stop.`} <FormulaHint label="Full-hold basis widening tolerance" formula="Unchanged-basis projected net ÷ (spot mid price × matched quantity × 1%)." note="The result is percentage points of additional basis widening that would consume the model's entire projected net over the planned hold. It is not an automatic stop-loss." /></li><li><strong>Margin risk:</strong> Review or reduce the position before an adverse perp move reaches the configured {inputs.shockPct}% shock, or sooner if your Binance account margin requires it. This site cannot calculate your liquidation price.</li><li><strong>Planned end:</strong> Requote both exit books at {Number.isInteger(inputs.days) ? inputs.days : "the chosen"} days. Exit earlier if expected remaining funding no longer covers closing costs and carry.</li></ul></div>}
    {mode === "overview" && opportunities.length > 0 && <div className="sim-alternatives"><h3>Ranked alternatives <small>Net USDT profit over {inputs.days} days</small></h3><div className="table-wrap"><table><thead><tr><th>STOCK</th><th>NET PROFIT</th><th>LEVERAGE</th><th>30D FUNDING / DAY</th><th>NEGATIVE EVENTS</th><th>INDICATIVE FUNDING</th><th>ENTRY PREMIUM</th><th>DEPTH</th><th>SHOCK BUFFER</th></tr></thead><tbody>{opportunities.map((item) => <tr key={item.ticker}><td><Link href={`/stocks/${item.ticker}`}><strong>{item.ticker}</strong></Link></td><td className={`number-cell ${signedClass(item.netProfit)}`}>{money(item.netProfit)}</td><td>{item.leverage}×</td><td className="number-cell">{formatPct(item.funding.dailyRate * 100, 3)}</td><td className="number-cell">{share(item.funding.negativeShare == null ? null : item.funding.negativeShare * 100)}</td><td className="number-cell">{formatPct(marketByTicker.get(item.ticker)?.fundingRate == null ? null : marketByTicker.get(item.ticker)!.fundingRate! * 100, 4)}</td><td className="number-cell">{formatPct(item.entryPremiumPct, 2)}</td><td className="number-cell">${formatCompact(item.bookCapacity)}</td><td className="number-cell">{formatPct(item.adverseMoveBufferPct, 1)}</td></tr>)}</tbody></table></div></div>}
    {mode === "detail" && fundingWindows.length > 0 && <div className="sim-history"><h3>Regular funding history <small>Special events excluded from the forward estimate</small></h3><div className="table-wrap"><table><thead><tr><th>WINDOW</th><th>EVENTS</th><th>AVG / EVENT <FormulaHint label="Average funding per event" formula="Sum of settled Regular funding rates in the window ÷ count of Regular events × 100%." /></th><th>AVG / DAY <FormulaHint label="Average regular funding per day" formula="Sum of settled Regular funding rates in the window ÷ observed days × 100%." /></th><th>ANNUALIZED PACE <FormulaHint label="Annualized regular funding pace" formula="Average regular funding rate per observed day × 365 × 100%. Simple annualization without compounding." /></th><th>NEGATIVE <FormulaHint label="Share of negative regular settlements" formula="Count of Regular funding events with a negative rate ÷ count of all Regular events × 100%." /></th><th>WORST UTC DAY <FormulaHint label="Worst UTC funding day" formula="For each UTC calendar day, sum its Regular funding event rates; show the lowest daily total × 100%." /></th><th>SPECIAL</th></tr></thead><tbody>{fundingWindows.map((item) => <tr key={item.days}><td>{item.days} days</td><td>{item.regularCount}</td><td className="number-cell">{formatPct(item.averagePerEvent == null ? null : item.averagePerEvent * 100, 4)}</td><td className="number-cell">{formatPct(item.regularCount ? item.dailyRate * 100 : null, 4)}</td><td className="number-cell">{formatPct(item.regularCount ? item.annualizedRate * 100 : null, 1)}</td><td className="number-cell">{share(item.negativeShare == null ? null : item.negativeShare * 100)}</td><td className="number-cell">{formatPct(item.worstDay == null ? null : item.worstDay * 100, 3)}</td><td>{item.specialCount}</td></tr>)}</tbody></table></div></div>}
  </section>;
}
