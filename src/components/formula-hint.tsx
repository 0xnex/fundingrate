"use client";

import { useRef } from "react";
import { Info, X } from "lucide-react";

export function FormulaHint({ label, formula, note }: { label: string; formula: string; note?: string }) {
  const popover = useRef<HTMLSpanElement>(null);

  return <span className="formula-hint">
    <button type="button" className="formula-trigger" aria-label={`How ${label} is calculated`} title={`How ${label} is calculated`} onClick={() => popover.current?.showPopover()}><Info size={14} aria-hidden="true" /></button>
    <span ref={popover} popover="auto" role="dialog" className="formula-dialog" aria-label={`${label} calculation`}>
      <span className="formula-dialog-heading"><span>HOW IT IS CALCULATED</span><button type="button" onClick={() => popover.current?.hidePopover()} aria-label="Close calculation"><X size={18} /></button></span>
      <strong className="formula-dialog-title">{label}</strong>
      <span className="formula-expression">{formula}</span>
      {note && <span className="formula-note">{note}</span>}
    </span>
  </span>;
}
