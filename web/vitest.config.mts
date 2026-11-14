import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const root = fileURLToPath(new URL(".", import.meta.url));

// Shared config: tests/server runs in node, tests/ui in jsdom.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${root}` },
      // "server-only" throws outside a React Server Components bundle; it's a no-op under test.
      { find: /^server-only$/, replacement: `${root}tests/server/helpers/server-only-stub.ts` },
    ],
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "server",
          environment: "node",
          include: ["tests/server/**/*.test.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
          pool: "forks",
        },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["tests/ui/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});
