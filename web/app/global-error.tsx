"use client";

/** Replaces the root layout when it fails, so it carries its own document and minimal inline styles. */
export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          background: "Canvas",
          color: "CanvasText",
          colorScheme: "light dark",
        }}
      >
        <title>Something went wrong · LiquidityX</title>
        <main style={{ maxWidth: 560, margin: "0 auto", padding: 24 }}>
          <h1 style={{ fontSize: 24, margin: 0 }}>LiquidityX didn&apos;t load.</h1>
          <p style={{ opacity: 0.75, fontSize: 14, lineHeight: 1.5 }}>Nothing was sent from your wallet. Reload to try again.</p>
          <button
            onClick={() => retry()}
            style={{ marginTop: 12, height: 36, padding: "0 14px", borderRadius: 6, border: 0, background: "#8e2a6c", color: "#fff", fontSize: 14, cursor: "pointer" }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
