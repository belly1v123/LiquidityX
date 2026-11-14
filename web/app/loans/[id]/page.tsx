import type { Metadata } from "next";
import { Suspense } from "react";
import { LoanView } from "@/components/loan/loan-view";
import { PageSkeleton } from "@/components/page-skeleton";

export async function generateMetadata({ params }: PageProps<"/loans/[id]">): Promise<Metadata> {
  const { id } = await params;
  return {
    title: `Loan #${id}`,
    description: `Live terms, collateral ratio and repayment progress for LiquidityX loan #${id}.`,
  };
}

export default function LoanPage({ params }: PageProps<"/loans/[id]">) {
  return (
    <Suspense fallback={<PageSkeleton aside />}>
      {params.then(({ id }) => (
        <LoanView id={id} />
      ))}
    </Suspense>
  );
}
