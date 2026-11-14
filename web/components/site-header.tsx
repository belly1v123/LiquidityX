"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { Logo } from "./logo";
import { ThemeToggle } from "./theme-toggle";
import { WalletButton } from "./wallet-button";
import { NetworkBanner } from "./network-banner";
import { cn } from "./ui/cn";

const NAV = [
  { href: "/marketplace", label: "Marketplace" },
  { href: "/lend", label: "Lend" },
  { href: "/borrow", label: "Borrow" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/activity", label: "Activity" },
];

const isActive = (pathname: string, href: string) => pathname === href || pathname.startsWith(href + "/");

function DesktopNav({ pathname }: { pathname: string }) {
  return (
    <ul className="flex items-center gap-1">
      {NAV.map((n) => (
        <li key={n.href}>
          <Link
            href={n.href}
            aria-current={isActive(pathname, n.href) ? "page" : undefined}
            className={cn(
              "rounded-md px-2.5 py-1.5 text-sm transition-colors duration-150",
              isActive(pathname, n.href) ? "font-medium text-ink" : "text-ink-2 hover:text-ink",
            )}
          >
            {n.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Reading the pathname is runtime data under Cache Components, so it sits behind its own Suspense boundary. */
function DesktopNavLive() {
  return <DesktopNav pathname={usePathname()} />;
}

function MobileNav({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const pathname = usePathname();
  useEffect(() => {
    onNavigate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);
  if (!open) return null;
  return (
    <nav id="mobile-nav" aria-label="Main" className="border-t border-line bg-bg md:hidden">
      <ul className="mx-auto flex max-w-[1240px] flex-col px-2 py-2">
        {NAV.map((n) => (
          <li key={n.href}>
            <Link
              href={n.href}
              aria-current={isActive(pathname, n.href) ? "page" : undefined}
              className={cn("block rounded-md px-3 py-2.5 text-sm", isActive(pathname, n.href) ? "bg-surface-2 font-medium text-ink" : "text-ink-2")}
            >
              {n.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg/95 backdrop-blur-[6px] supports-[backdrop-filter]:bg-bg/85">
      <div className="mx-auto flex h-14 max-w-[1240px] items-center gap-6 px-4 sm:px-6">
        <Link href="/" aria-label="LiquidityX home" className="flex shrink-0 items-center gap-2.5 rounded-md">
          <Logo />
          <span
            className="hidden rounded-sm border border-line px-1.5 py-px text-2xs text-ink-3 sm:inline"
            title="Everything here runs on Mezo testnet. Tokens have no real value."
          >
            Testnet
          </span>
        </Link>
        <nav aria-label="Main" className="hidden md:block">
          <Suspense fallback={<DesktopNav pathname="" />}>
            <DesktopNavLive />
          </Suspense>
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          <ThemeToggle />
          <WalletButton />
          <button
            type="button"
            className="grid size-9 place-items-center rounded-md text-ink-2 hover:bg-surface-2 hover:text-ink md:hidden"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls="mobile-nav"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X className="size-4" strokeWidth={1.75} /> : <Menu className="size-4" strokeWidth={1.75} />}
          </button>
        </div>
      </div>
      <Suspense fallback={null}>
        <MobileNav open={open} onNavigate={() => setOpen(false)} />
      </Suspense>
      <NetworkBanner />
    </header>
  );
}
