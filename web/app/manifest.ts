import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "LiquidityX",
    short_name: "LiquidityX",
    description: "Peer-to-peer fixed-rate loans backed by BTC.",
    start_url: "/",
    display: "standalone",
    background_color: "#fcfbfc",
    theme_color: "#8e2a6c",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
