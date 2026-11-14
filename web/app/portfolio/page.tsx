import type { Metadata } from "next";
import { PortfolioView } from "@/components/portfolio/portfolio-view";

export const metadata: Metadata = {
  title: "Portfolio",
  description: "Your deposits, loans, collateral and repayments.",
  robots: { index: false },
};

export default function PortfolioPage() {
  return <PortfolioView />;
}
