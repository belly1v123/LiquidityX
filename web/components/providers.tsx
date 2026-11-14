"use client";
import "@rainbow-me/rainbowkit/styles.css";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, darkTheme, lightTheme, type Theme } from "@rainbow-me/rainbowkit";
import { Toaster } from "sonner";
import { WagmiProvider } from "wagmi";
import { activeChain } from "@/lib/chain";
import { wagmiConfig } from "@/lib/wagmi";
import { ThemeProvider, useTheme } from "./theme";

function rkTheme(mode: "light" | "dark"): Theme {
  const base = (mode === "dark" ? darkTheme : lightTheme)({
    accentColor: "var(--accent)",
    accentColorForeground: "var(--accent-ink)",
    borderRadius: "small",
    fontStack: "system",
    overlayBlur: "none",
  });
  return {
    ...base,
    fonts: { body: "var(--font-sans)" },
    colors: {
      ...base.colors,
      modalBackground: "var(--bg)",
      modalBorder: "var(--line)",
      modalText: "var(--ink)",
      modalTextSecondary: "var(--ink-2)",
      modalBackdrop: "var(--overlay)",
      generalBorder: "var(--line)",
      actionButtonSecondaryBackground: "var(--surface-2)",
      closeButtonBackground: "var(--surface-2)",
      closeButton: "var(--ink-2)",
      menuItemBackground: "var(--surface-2)",
      profileForeground: "var(--bg)",
    },
    shadows: { ...base.shadows, dialog: "var(--shadow-pop)", connectButton: "none" },
  };
}

function Inner({ children }: { children: React.ReactNode }) {
  const { resolved } = useTheme();
  return (
    <RainbowKitProvider theme={rkTheme(resolved)} initialChain={activeChain} modalSize="compact" appInfo={{ appName: "LiquidityX" }}>
      {children}
      <Toaster
        theme={resolved}
        position="bottom-right"
        closeButton
        visibleToasts={4}
        toastOptions={{
          classNames: {
            toast: "!bg-bg !text-ink !border-line !shadow-pop !rounded-lg !font-sans",
            description: "!text-ink-2",
            closeButton: "!bg-bg !border-line !text-ink-2",
          },
        }}
      />
    </RainbowKitProvider>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: true } },
      }),
  );
  return (
    <ThemeProvider>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={qc}>
          <Inner>{children}</Inner>
        </QueryClientProvider>
      </WagmiProvider>
    </ThemeProvider>
  );
}
