"use client";

import Link from "next/link";
import { Activity, ArrowLeft, ArrowUpRight, Database, RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";

export const RANGES = [7, 30, 90] as const;
export type RangeDays = typeof RANGES[number];

export function formatPct(value: number | null | undefined, digits = 3) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

export function formatCompact(value: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function formatUtc(value: string | number | null | undefined) {
  if (value == null) return "—";
  return new Date(value).toLocaleString("en-US", { timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) + " UTC";
}

export function signedClass(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "muted";
  return value > 0 ? "positive" : value < 0 ? "negative" : "muted";
}

export function AppHeader({ ticker }: { ticker?: string }) {
  const queryClient = useQueryClient();
  return <header className="app-header">
    <div className="header-inner">
      <Link href="/" className="brand" aria-label="Fundingrate home"><span className="brand-mark"><Activity size={19} strokeWidth={2.4} /></span><span>funding<span className="brand-accent">rate</span><span className="brand-dot">.</span></span></Link>
      <nav className="header-nav" aria-label="Primary navigation"><Link href="/" className="nav-active">Overview</Link><span className="nav-divider" /><span>US equities</span>{ticker && <><span className="nav-divider" /><span className="nav-current">{ticker}</span></>}</nav>
      <div className="header-actions"><span className="source-pill"><span className="live-dot" /> BINANCE DATA</span><button className="icon-button" aria-label="Refresh dashboard data" title="Refresh dashboard data" onClick={() => void queryClient.invalidateQueries()}><RefreshCw size={17} /></button></div>
    </div>
  </header>;
}

export function PageFooter() {
  return <footer className="page-footer"><div><Database size={14} /> Binance market data · Stored in Supabase · Calculated in your browser</div><a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">Charts by TradingView <ArrowUpRight size={13} /></a></footer>;
}

export function RangePicker({ value, onChange }: { value: RangeDays; onChange: (value: RangeDays) => void }) {
  return <div className="range-picker" aria-label="History window">{RANGES.map((days) => <button key={days} type="button" className={value === days ? "range-active" : ""} onClick={() => onChange(days)}>{days}D</button>)}</div>;
}

export function BackLink() {
  return <Link href="/" className="back-link"><ArrowLeft size={16} /> Back to overview</Link>;
}

export function DataMessage({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="data-message"><div className="data-message-icon"><Database size={22} /></div><h2>{title}</h2><p>{children}</p></div>;
}
