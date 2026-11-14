export const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");

export const siteDescription =
  "Put idle stablecoin liquidity to work. Borrow against Bitcoin. Set the terms yourself. Peer-to-peer fixed-rate loans, settled by smart contracts.";
