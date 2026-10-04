"use client";

import { assessEntryDepth, type MarketSnapshot } from "@/lib/strategy";
import { formatPct, formatUtc } from "./ui";
import { FormulaHint } from "./formula-hint";

function cash(value: number) {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function price(value: number) {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

function shares(value: number) {
  return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

export function OrderbookDepth({ market, spotSymbol, perpSymbol, targetNotional, modeledSize, fetching, nowMs }: {
  market: MarketSnapshot | null | undefined;
  spotSymbol: string | null;
  perpSymbol: string;
  targetNotional: number;
  modeledSize: boolean;
  fetching: boolean;
  nowMs: number;
}) {
  const spot = market?.spotBook;
  const perp = market?.perpBook;
  const booksFresh = !!spot && !!perp && [spot.fetchedAt, perp.fetchedAt].every((time) => {
    const age = nowMs - Date.parse(time);
    return Number.isFinite(age) && age >= -5_000 && age <= 60_000;
  });
  const depth = booksFresh && spot && perp ? assessEntryDepth(spot, perp, targetNotional) : null;
  const canFill = !!depth?.spotFill && !!depth?.perpFill;
  const tightDepth = depth?.bands[1].pairedUsdt ?? 0;
  const fitsTightDepth = tightDepth >= targetNotional;
  const source = market?.source === "browser" ? "Browser → Binance" : market?.source === "server" ? "Vercel fallback" : "Waiting for books";

  return <section className="sim-depth" aria-label="Current paired order-book depth" aria-busy={fetching}>
    <div className="sim-depth-heading"><div><span className="sim-caption">CURRENT ENTRY LIQUIDITY</span><h3>Spot ask + perpetual bid depth</h3><p>Both legs must fill the same number of shares to open the hedge.</p></div><span className="sim-depth-source">{fetching && <span className="loading-spinner" aria-hidden="true" />}{source} · {formatUtc(market?.fetchedAt)}</span></div>
    {!spotSymbol ? <p className="sim-depth-message">No matching bStock spot pair is available for this perpetual.</p>
      : !(targetNotional > 0 && Number.isFinite(targetNotional)) ? <p className="sim-depth-message">Enter a positive cash budget to check the available depth.</p>
      : !depth ? <p className="sim-depth-message">{fetching ? "Loading both Binance order books…" : "Fresh spot and perpetual books are unavailable. The page retries while it is open."}</p>
        : <>
          <div className="sim-depth-cards">
            <div><span>CHECKED POSITION SIZE <FormulaHint label="Checked matched share quantity" formula="Checked USDT position size ÷ best spot ask price = shares required on both legs." note="When a feasible strategy model exists, the checked USDT size is its matched perpetual notional; otherwise it is the entered cash budget as a depth reference." /></span><strong>{cash(targetNotional)}</strong><small>{modeledSize ? "Modeled matched notional" : "Cash budget reference"} · {depth.quantity.toLocaleString("en-US", { maximumFractionDigits: 5 })} shares</small></div>
            <div><span>BUY {spotSymbol} SPOT</span><strong>{price(depth.spotBestAsk)}</strong><small>Best ask · {shares(spot!.asks[0][1])} shares at top level</small></div>
            <div><span>SHORT {perpSymbol}</span><strong>{price(depth.perpBestBid)}</strong><small>Best bid · {shares(perp!.bids[0][1])} shares at top level</small></div>
            <div className={fitsTightDepth ? "depth-can-fill" : "depth-cannot-fill"}><span>MATCHED WITHIN 0.5% <FormulaHint label="Matched depth within 0.5%" formula="Minimum of (spot ask shares priced within 0.5% above best ask) and (perpetual bid shares priced within 0.5% below best bid), multiplied by best spot ask price." /></span><strong>{cash(tightDepth)}</strong><small>{fitsTightDepth ? "Checked size fits within 0.5% on both legs" : "Checked size requires deeper levels on at least one leg"}</small></div>
          </div>
          <div className="sim-depth-bands"><div className="sim-depth-band-head"><span>FROM BEST PRICE</span><span>SPOT ASKS <FormulaHint label="Spot ask depth by price band" formula="Sum of spot ask level price × available shares for all asks no more than the stated percentage above the best ask." /></span><span>PERP BIDS <FormulaHint label="Perpetual bid depth by price band" formula="Sum of perpetual bid level price × available shares for all bids no more than the stated percentage below the best bid." /></span><span>MATCHED SIZE <FormulaHint label="Matched depth by price band" formula="Minimum of available spot ask shares and perpetual bid shares inside the band × best spot ask price." /></span></div>{depth.bands.map((band) => <div className="sim-depth-band" key={band.movePct}><span>Within {band.movePct.toFixed(1)}% <FormulaHint label={`Depth within ${band.movePct.toFixed(1)}%`} formula="Spot asks = sum of price × shares within the band above best ask. Perpetual bids = sum of price × shares within the band below best bid. Matched size = the smaller share quantity on the two legs × best spot ask." /></span><span><small>Spot asks</small>{cash(band.spotUsdt)}</span><span><small>Perp bids</small>{cash(band.perpUsdt)}</span><strong className={band.pairedUsdt >= targetNotional ? "positive" : "depth-short"}><small>Matched</small>{cash(band.pairedUsdt)}</strong></div>)}</div>
          <div className="sim-depth-fill"><span>At checked size <strong>{canFill ? "Both legs visible" : "Insufficient visible depth"}</strong></span><span>Spot buy VWAP <FormulaHint label="Spot buy VWAP" formula="Sum of filled spot ask price × shares ÷ checked share quantity. Walks asks from best to worse until the whole size is filled." /><strong>{depth.spotFill ? price(depth.spotFill.vwap) : "—"}</strong></span><span>Perp sell VWAP <FormulaHint label="Perpetual sell VWAP" formula="Sum of filled perpetual bid price × shares ÷ checked share quantity. Walks bids from best to worse until the whole size is filled." /><strong>{depth.perpFill ? price(depth.perpFill.vwap) : "—"}</strong></span><span>Combined entry slippage <FormulaHint label="Combined entry slippage" formula="|Spot buy VWAP ÷ best spot ask − 1| × 100% + |perpetual sell VWAP ÷ best perp bid − 1| × 100%." /><strong>{canFill ? formatPct(depth.spotFill!.slippage + depth.perpFill!.slippage, 3) : "—"}</strong></span><span>Executable premium <FormulaHint label="Executable entry premium" formula="(Perpetual sell VWAP ÷ spot buy VWAP − 1) × 100% at the checked share quantity." /><strong>{formatPct(depth.entryPremiumPct, 3)}</strong></span></div>
          <p className="sim-depth-note">Visible {spot!.asks.length} spot ask and {perp!.bids.length} perpetual bid levels; total visible paired capacity is {cash(depth.pairedDepthUsdt)}. Matched capacity converts the smaller share quantity at the best spot ask; each leg&apos;s depth uses its displayed prices. Snapshots refresh every 10 seconds while this page is open. Orders can move or disappear before execution.</p>
        </>}
  </section>;
}
