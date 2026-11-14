import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  serverExternalPackages: ["@electric-sql/pglite"],
  // Mezo Passport and its OrangeKit smart-account packages ship raw TypeScript sources.
  transpilePackages: ["@mezo-org/passport", "@mezo-org/orangekit", "@mezo-org/orangekit-smart-account", "@mezo-org/orangekit-contracts"],
  partialPrefetching: true,
  turbopack: {
    // @base-org/account (pulled in by RainbowKit's Base connector) imports optional @x402/* packages
    // that aren't installed and aren't used here. Resolve them to an empty module.
    resolveAlias: Object.fromEntries(
      [
        "@x402/core/client",
        "@x402/evm",
        "@x402/evm/exact/client",
        "@x402/evm/upto/client",
        "@x402/svm",
        "@x402/svm/exact/client",
      ].map((m) => [m, "./components/stubs/empty.js"]),
    ),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
