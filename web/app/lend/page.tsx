import type { Metadata } from "next";
import { LendView } from "@/components/lend/lend-view";

export const metadata: Metadata = {
  title: "Lend",
  description: "Deposit MUSD and post a fixed-rate offer with your own APR, term and collateral requirement.",
};

export default function LendPage() {
  return <LendView />;
}
