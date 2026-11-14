import type { Metadata } from "next";
import { Suspense } from "react";
import { MarketplaceView } from "@/components/marketplace/marketplace-view";
import { PageSkeleton } from "@/components/page-skeleton";

export const metadata: Metadata = {
  title: "Marketplace",
  description: "Open borrow requests and lend offers with live collateral ratios. Fund, borrow or match in one click.",
};

export default function MarketplacePage() {
  return (
    <Suspense fallback={<PageSkeleton rows={8} />}>
      <MarketplaceView />
    </Suspense>
  );
}
