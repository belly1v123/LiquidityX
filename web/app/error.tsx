"use client";
import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function Error({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const digest = error instanceof Error && "digest" in error ? String((error as { digest?: string }).digest ?? "") : "";
  return (
    <div className="mx-auto flex w-full max-w-[1240px] flex-1 flex-col justify-center px-4 py-24 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">This page didn&apos;t load.</h1>
      <p className="mt-2 max-w-[56ch] text-sm text-ink-2">
        Nothing was sent from your wallet. Try again; if it keeps happening, the testnet RPC may be slow.
      </p>
      {digest && <p className="num mt-2 text-xs text-ink-3">Reference {digest}</p>}
      <div className="mt-6 flex gap-2">
        <Button onClick={() => retry()}>Try again</Button>
        <Link href="/" className="inline-flex h-9 items-center px-3 text-sm text-ink-2 hover:text-ink">Home</Link>
      </div>
    </div>
  );
}
