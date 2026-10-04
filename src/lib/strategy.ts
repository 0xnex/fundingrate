import { DAY_MS } from "./market";
import type { FundingEvent } from "./analytics";

export type BookLevel = [price: number, quantity: number];
export interface OrderBook { bids: BookLevel[]; asks: BookLevel[]; fetchedAt: string; sourceTime?: number }
export interface MarketSnapshot {
  ticker: string;
  fetchedAt: string;
  fundingRate: number | null;
  quoteTime: number | null;
  nextFundingTime: number | null;
  markPrice: number | null;
  openInterest: number | null;
  openInterestTime: number | null;
  perpBook: OrderBook | null;
  spotBook: OrderBook | null;
  source?: "browser" | "server";
  error?: string;
}

export interface FundingStats {
  days: number;
  regularCount: number;
  specialCount: number;
  regularSum: number;
  totalSum: number;
  averagePerEvent: number | null;
  dailyRate: number;
  annualizedRate: number;
  negativeShare: number | null;
  worstDay: number | null;
  observedDays: number;
}

export function summarizeFunding(events: FundingEvent[], endMs: number, days: number): FundingStats {
  const window = events.filter((event) => {
    const time = Date.parse(event.funding_time);
    return time >= endMs - days * DAY_MS && time < endMs && Number.isFinite(event.funding_rate);
  });
  const regular = window.filter((event) => event.rate_type === "Regular");
  const regularSum = regular.reduce((sum, event) => sum + event.funding_rate, 0);
  const totalSum = window.reduce((sum, event) => sum + event.funding_rate, 0);
  const byDay = new Map<number, number>();
  for (const event of regular) {
    const day = Math.floor(Date.parse(event.funding_time) / DAY_MS);
    byDay.set(day, (byDay.get(day) ?? 0) + event.funding_rate);
  }
  const firstTime = regular.length ? Math.min(...regular.map((event) => Date.parse(event.funding_time))) : endMs;
  const observedDays = regular.length ? Math.min(days, Math.max(1, (endMs - firstTime) / DAY_MS)) : 0;
  return {
    days, regularCount: regular.length, specialCount: window.filter((event) => event.rate_type === "Special").length,
    regularSum, totalSum,
    averagePerEvent: regular.length ? regularSum / regular.length : null,
    dailyRate: observedDays ? regularSum / observedDays : 0,
    annualizedRate: observedDays ? regularSum / observedDays * 365 : 0,
    negativeShare: regular.length ? regular.filter((event) => event.funding_rate < 0).length / regular.length : null,
    worstDay: byDay.size ? Math.min(...byDay.values()) : null,
    observedDays,
  };
}

export interface StrategyInputs {
  budget: number;
  days: number;
  shockPct: number;
  reservePct: number;
  spotFeePct: number;
  perpFeePct: number;
  carryingPctAnnual: number;
}

export const DEFAULT_STRATEGY_INPUTS: StrategyInputs = {
  budget: 100_000, days: 90, shockPct: 30, reservePct: 10,
  spotFeePct: 0.1, perpFeePct: 0.05, carryingPctAnnual: 0,
};

export interface HistoricalPreview {
  leverage: number;
  notional: number;
  spotCash: number;
  initialMargin: number;
  reserve: number;
  adverseMoveBufferPct: number;
  grossFunding: number;
  fees: number;
  carryingCost: number;
  netBeforeExecution: number;
}

// A quote-free budget illustration. Equal spot/perp prices and no book costs
// are assumed; this result must never be used as an executable opportunity.
export function estimateHistoricalPreview(inputs: StrategyInputs, dailyFundingRate: number): HistoricalPreview | null {
  if (!(Number.isFinite(inputs.budget) && inputs.budget > 0 && Number.isInteger(inputs.days) && inputs.days >= 1 && inputs.days <= 365
    && Number.isFinite(dailyFundingRate) && Number.isFinite(inputs.shockPct) && inputs.shockPct >= 0 && inputs.shockPct < 100
    && Number.isFinite(inputs.reservePct) && inputs.reservePct >= 0 && inputs.reservePct < 100
    && Number.isFinite(inputs.spotFeePct) && inputs.spotFeePct >= 0 && Number.isFinite(inputs.perpFeePct) && inputs.perpFeePct >= 0
    && Number.isFinite(inputs.carryingPctAnnual) && inputs.carryingPctAnnual >= 0)) return null;
  const reserve = inputs.budget * inputs.reservePct / 100;
  const feeRate = 2 * (inputs.spotFeePct + inputs.perpFeePct) / 100;
  const shockPlusCushion = (inputs.shockPct + 5) / 100;
  let best: HistoricalPreview | null = null;
  for (let leverage = 1; leverage <= 10; leverage++) {
    const budgetCap = (inputs.budget - reserve) / (1 + 1 / leverage + feeRate);
    const stressGap = shockPlusCushion - 1 / leverage;
    const stressCap = stressGap > 0 ? reserve / stressGap : Number.POSITIVE_INFINITY;
    const notional = Math.min(budgetCap, stressCap);
    if (!(notional > 0 && Number.isFinite(notional))) continue;
    const spotCash = notional;
    const initialMargin = notional / leverage;
    const fees = notional * feeRate;
    const grossFunding = notional * dailyFundingRate * inputs.days;
    const carryingCost = spotCash * inputs.carryingPctAnnual / 100 * inputs.days / 365;
    const preview = {
      leverage, notional, spotCash, initialMargin, reserve,
      adverseMoveBufferPct: (initialMargin + reserve) / notional * 100 - 5,
      grossFunding, fees, carryingCost,
      netBeforeExecution: grossFunding - fees - carryingCost,
    };
    if (!best || preview.notional > best.notional) best = preview;
  }
  return best;
}

export interface Fill { quantity: number; notional: number; vwap: number; slippage: number }

export function fillBook(levels: BookLevel[], quantity: number): Fill | null {
  if (!Number.isFinite(quantity) || quantity <= 0 || !levels.length) return null;
  let remaining = quantity;
  let notional = 0;
  for (const [price, available] of levels) {
    if (!(price > 0 && available > 0 && Number.isFinite(price) && Number.isFinite(available))) return null;
    const used = Math.min(remaining, available);
    notional += price * used;
    remaining -= used;
    if (remaining <= quantity * 1e-10) break;
  }
  if (remaining > quantity * 1e-10) return null;
  const vwap = notional / quantity;
  return { quantity, notional, vwap, slippage: Math.abs(vwap / levels[0][0] - 1) * 100 };
}

export interface EntryDepth {
  quantity: number;
  spotBestAsk: number;
  perpBestBid: number;
  spotDepthUsdt: number;
  perpDepthUsdt: number;
  pairedDepthUsdt: number;
  bands: { movePct: number; spotUsdt: number; perpUsdt: number; pairedUsdt: number }[];
  spotFill: Fill | null;
  perpFill: Fill | null;
  entryPremiumPct: number | null;
}

export function assessEntryDepth(spot: OrderBook, perp: OrderBook, targetNotional: number): EntryDepth | null {
  if (!(Number.isFinite(targetNotional) && targetNotional > 0 && spot.asks[0]?.[0] > 0 && perp.bids[0]?.[0] > 0)) return null;
  const spotBestAsk = spot.asks[0][0];
  const perpBestBid = perp.bids[0][0];
  const quantity = targetNotional / spotBestAsk;
  const spotDepthQty = spot.asks.reduce((sum, [, size]) => sum + size, 0);
  const perpDepthQty = perp.bids.reduce((sum, [, size]) => sum + size, 0);
  const spotFill = fillBook(spot.asks, quantity);
  const perpFill = fillBook(perp.bids, quantity);
  const bands = [0.1, 0.5, 1].map((movePct) => {
    const spotLevels = spot.asks.filter(([price]) => price <= spotBestAsk * (1 + movePct / 100));
    const perpLevels = perp.bids.filter(([price]) => price >= perpBestBid * (1 - movePct / 100));
    const spotQty = spotLevels.reduce((sum, [, size]) => sum + size, 0);
    const perpQty = perpLevels.reduce((sum, [, size]) => sum + size, 0);
    return {
      movePct,
      spotUsdt: spotLevels.reduce((sum, [price, size]) => sum + price * size, 0),
      perpUsdt: perpLevels.reduce((sum, [price, size]) => sum + price * size, 0),
      pairedUsdt: Math.min(spotQty, perpQty) * spotBestAsk,
    };
  });
  return {
    quantity, spotBestAsk, perpBestBid,
    spotDepthUsdt: spot.asks.reduce((sum, [price, size]) => sum + price * size, 0),
    perpDepthUsdt: perp.bids.reduce((sum, [price, size]) => sum + price * size, 0),
    pairedDepthUsdt: Math.min(spotDepthQty, perpDepthQty) * spotBestAsk,
    bands, spotFill, perpFill,
    entryPremiumPct: spotFill && perpFill ? (perpFill.vwap / spotFill.vwap - 1) * 100 : null,
  };
}

export interface Opportunity {
  ticker: string;
  leverage: number;
  quantity: number;
  entrySpotPrice: number;
  entryPerpPrice: number;
  spotCash: number;
  perpNotional: number;
  initialMargin: number;
  reserve: number;
  totalFees: number;
  executionCost: number;
  entryPremiumPct: number;
  spotSpreadPct: number;
  perpSpreadPct: number;
  entrySlippagePct: number;
  projectedFunding: number;
  carryingCost: number;
  netProfit: number;
  netAnnualizedPct: number;
  zeroBasisProfit: number;
  widerBasisProfit: number;
  breakEvenDays: number | null;
  adverseMoveBufferPct: number;
  bookCapacity: number;
  funding: FundingStats;
}

function capacity(book: OrderBook) {
  return Math.min(
    book.bids.reduce((sum, [, qty]) => sum + qty, 0),
    book.asks.reduce((sum, [, qty]) => sum + qty, 0),
  );
}

export function marketIsFresh(snapshot: MarketSnapshot, nowMs: number): boolean {
  if (!snapshot.perpBook || !snapshot.spotBook || !snapshot.markPrice || !snapshot.quoteTime) return false;
  const quoteAge = nowMs - snapshot.quoteTime;
  if (!(quoteAge >= -5000 && quoteAge <= 60_000)) return false;
  return [snapshot.fetchedAt, snapshot.perpBook.fetchedAt, snapshot.spotBook.fetchedAt]
    .every((time) => { const age = nowMs - Date.parse(time); return Number.isFinite(age) && age >= -5000 && age <= 60_000; });
}

export function simulateOpportunity(
  snapshot: MarketSnapshot, events: FundingEvent[], endMs: number,
  inputs: StrategyInputs, nowMs: number,
): Opportunity | null {
  if (!marketIsFresh(snapshot, nowMs) || !snapshot.perpBook || !snapshot.spotBook || !snapshot.markPrice) return null;
  if (!(inputs.budget > 0 && Number.isFinite(inputs.budget) && Number.isInteger(inputs.days) && inputs.days >= 1 && inputs.days <= 365 && inputs.shockPct >= 0 && inputs.shockPct < 100 && inputs.reservePct >= 0 && inputs.reservePct < 100 && inputs.spotFeePct >= 0 && inputs.perpFeePct >= 0 && inputs.carryingPctAnnual >= 0)) return null;
  const funding = summarizeFunding(events, endMs, 30);
  if (funding.observedDays < 7 || funding.regularCount === 0) return null;
  const spot = snapshot.spotBook;
  const perp = snapshot.perpBook;
  if (!spot.bids[0] || !spot.asks[0] || !perp.bids[0] || !perp.asks[0]) return null;
  const spotMid = (spot.bids[0][0] + spot.asks[0][0]) / 2;
  const perpMid = (perp.bids[0][0] + perp.asks[0][0]) / 2;
  const reserve = inputs.budget * inputs.reservePct / 100;
  const maxQty = Math.min(capacity(spot), capacity(perp));
  let best: Opportunity | null = null;
  for (let leverage = 1; leverage <= 10; leverage++) {
    const evaluate = (quantity: number): Opportunity | null => {
      const spotBuy = fillBook(spot.asks, quantity);
      const spotSell = fillBook(spot.bids, quantity);
      const perpSell = fillBook(perp.bids, quantity);
      const perpBuy = fillBook(perp.asks, quantity);
      if (!spotBuy || !spotSell || !perpSell || !perpBuy) return null;
      const perpNotional = quantity * snapshot.markPrice!;
      const initialMargin = perpNotional / leverage;
      const totalFees = inputs.spotFeePct / 100 * (spotBuy.notional + spotSell.notional)
        + inputs.perpFeePct / 100 * (perpSell.notional + perpBuy.notional);
      if (spotBuy.notional + initialMargin + reserve + totalFees > inputs.budget + 1e-7) return null;
      const adverseMoveBufferPct = (initialMargin + reserve) / perpNotional * 100 - 5;
      if (adverseMoveBufferPct + 1e-7 < inputs.shockPct) return null;
      const executionCost = spotBuy.notional - spotSell.notional + perpBuy.notional - perpSell.notional;
      const projectedFunding = perpNotional * funding.dailyRate * inputs.days;
      const carryingCost = spotBuy.notional * inputs.carryingPctAnnual / 100 * inputs.days / 365;
      const netProfit = projectedFunding - totalFees - executionCost - carryingCost;
      const entryPremiumPct = (perpSell.vwap / spotBuy.vwap - 1) * 100;
      const midBasisValue = (perpMid - spotMid) * quantity;
      return {
        ticker: snapshot.ticker, leverage, quantity, entrySpotPrice: spotBuy.vwap, entryPerpPrice: perpSell.vwap, spotCash: spotBuy.notional,
        perpNotional, initialMargin, reserve, totalFees, executionCost, entryPremiumPct,
        spotSpreadPct: (spot.asks[0][0] / spot.bids[0][0] - 1) * 100,
        perpSpreadPct: (perp.asks[0][0] / perp.bids[0][0] - 1) * 100,
        entrySlippagePct: spotBuy.slippage + perpSell.slippage,
        projectedFunding, carryingCost, netProfit,
        netAnnualizedPct: netProfit / inputs.budget * 365 / inputs.days * 100,
        zeroBasisProfit: netProfit + midBasisValue,
        widerBasisProfit: netProfit - spotMid * quantity * 0.01,
        breakEvenDays: perpNotional * funding.dailyRate - spotBuy.notional * inputs.carryingPctAnnual / 100 / 365 > 0
          ? (totalFees + executionCost) / (perpNotional * funding.dailyRate - spotBuy.notional * inputs.carryingPctAnnual / 100 / 365) : null,
        adverseMoveBufferPct, bookCapacity: maxQty * spotMid, funding,
      };
    };
    let low = 0;
    let high = maxQty;
    for (let step = 0; step < 38; step++) {
      const mid = (low + high) / 2;
      if (evaluate(mid)) low = mid; else high = mid;
    }
    // Fills, fees, and funding are linear between order-book levels. The best
    // size can therefore sit at a depth breakpoint rather than at the budget cap.
    const candidates = new Set([low]);
    for (const levels of [spot.asks, spot.bids, perp.bids, perp.asks]) {
      let cumulative = 0;
      for (const [, quantity] of levels) {
        cumulative += quantity;
        if (cumulative > 0 && cumulative < low) candidates.add(cumulative);
      }
    }
    for (const quantity of candidates) {
      const opportunity = evaluate(quantity);
      if (opportunity && (!best || opportunity.netProfit > best.netProfit)) best = opportunity;
    }
  }
  return best;
}

export function rankOpportunities(opportunities: Opportunity[]): Opportunity[] {
  return [...opportunities].sort((a, b) => b.netProfit - a.netProfit || a.ticker.localeCompare(b.ticker));
}
