import type { Metadata } from "next";
import { StockDetail } from "@/components/stock-detail";

export async function generateMetadata({ params }: { params: Promise<{ ticker: string }> }): Promise<Metadata> {
  const { ticker } = await params;
  return { title: `${ticker.toUpperCase()} | Fundingrate` };
}

export default async function Page({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await params;
  return <StockDetail ticker={ticker.toUpperCase()} />;
}
