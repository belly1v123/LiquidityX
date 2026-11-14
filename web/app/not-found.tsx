import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui/button";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <div className="mx-auto flex w-full max-w-[1240px] flex-1 flex-col justify-center px-4 py-24 sm:px-6">
      <p className="num text-sm text-ink-3">404</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">There&apos;s no page here.</h1>
      <p className="mt-2 max-w-[52ch] text-sm text-ink-2">The link may be old, or the loan number may be wrong.</p>
      <div className="mt-6 flex gap-2">
        <ButtonLink href="/marketplace">Explore marketplace</ButtonLink>
        <ButtonLink href="/" variant="ghost">Home</ButtonLink>
      </div>
    </div>
  );
}
