import type { Metadata } from "next";
import { BorrowView } from "@/components/borrow/borrow-view";

export const metadata: Metadata = {
  title: "Borrow",
  description: "Lock BTC and request a fixed-rate stablecoin loan. See your collateral ratio and liquidation price before you sign.",
};

export default function BorrowPage() {
  return <BorrowView />;
}
