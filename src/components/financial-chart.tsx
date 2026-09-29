"use client";

import { useEffect, useRef } from "react";
import type { IChartApi, UTCTimestamp } from "lightweight-charts";

export interface ChartSeries {
  name: string;
  color: string;
  points: { time: number; value: number; color?: string }[];
  dashed?: boolean;
  steps?: boolean;
}

export function FinancialChart({ series, height = 260, histogram = false }: {
  series: ChartSeries[];
  height?: number;
  histogram?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    let cancelled = false;
    let observer: ResizeObserver | undefined;
    void import("lightweight-charts").then(({ createChart, LineSeries, HistogramSeries, ColorType, LineStyle, LineType }) => {
      if (cancelled || !container.current) return;
      const chart = createChart(container.current, {
        width: container.current.clientWidth,
        height,
        layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#929292", fontFamily: "Inter, Arial, sans-serif", fontSize: 11 },
        grid: { vertLines: { color: "#242424" }, horzLines: { color: "#242424" } },
        rightPriceScale: { borderColor: "#383838" },
        timeScale: { borderColor: "#383838", timeVisible: true, secondsVisible: false, rightOffset: 1 },
        crosshair: { vertLine: { color: "#777777" }, horzLine: { color: "#777777" } },
        handleScale: { mouseWheel: false },
      });
      chartRef.current = chart;
      for (const item of series) {
        const data = [...item.points].sort((a, b) => a.time - b.time);
        if (histogram) {
          const line = chart.addSeries(HistogramSeries, { color: item.color, priceLineVisible: false, lastValueVisible: false, priceFormat: { type: "price", precision: 4, minMove: 0.0001 } });
          line.setData(data.filter((point) => Number.isFinite(point.value)).map((point) => ({ time: Math.floor(point.time / 1000) as UTCTimestamp, value: point.value, color: point.color ?? item.color })));
        } else {
          const line = chart.addSeries(LineSeries, { color: item.color, lineWidth: 2, lineStyle: item.dashed ? LineStyle.Dashed : LineStyle.Solid, lineType: item.steps ? LineType.WithSteps : LineType.Simple, priceLineVisible: false, lastValueVisible: false, priceFormat: { type: "price", precision: 2, minMove: 0.01 } });
          line.setData(data.map((point) => Number.isFinite(point.value)
            ? { time: Math.floor(point.time / 1000) as UTCTimestamp, value: point.value }
            : { time: Math.floor(point.time / 1000) as UTCTimestamp }));
        }
      }
      chart.timeScale().fitContent();
      observer = new ResizeObserver(() => chart.applyOptions({ width: container.current?.clientWidth ?? 0 }));
      observer.observe(container.current);
    });
    return () => {
      cancelled = true;
      observer?.disconnect();
      chartRef.current?.remove();
      chartRef.current = null;
    };
  }, [series, height, histogram]);

  return <div ref={container} className="chart" style={{ height }} role="img" aria-label={`${series.map((item) => item.name).join(" and ")} chart`} />;
}
