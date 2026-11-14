/** Shared Open Graph card layout (rendered by next/og, so inline styles only). */
export const OG_SIZE = { width: 1200, height: 630 };

const PLUM = "#8e2a6c";

function Mark({ size = 56 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <rect width="32" height="32" rx="7" fill={PLUM} />
      <path d="M10 10 22 22M22 10l-4.6 4.6M14.6 17.4 10 22" fill="none" stroke="#fdf9fb" strokeWidth="3.2" strokeLinecap="round" />
    </svg>
  );
}

export function OgCard({ title, lines, foot }: { title: string; lines?: string[]; foot: string }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: "#fcfbfc",
        color: "#231a20",
        padding: "72px 80px",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <Mark />
        <div style={{ fontSize: 34, fontWeight: 600, letterSpacing: -0.5 }}>LiquidityX</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ fontSize: 68, fontWeight: 700, lineHeight: 1.06, letterSpacing: -1.6, maxWidth: 980 }}>{title}</div>
        {lines?.map((l) => (
          <div key={l} style={{ fontSize: 34, color: "#5c5058" }}>
            {l}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "2px solid #e6e1e4", paddingTop: 26, fontSize: 26, color: "#6f636b" }}>
        <div>{foot}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 12, height: 12, borderRadius: 6, background: PLUM }} />
          Mezo testnet
        </div>
      </div>
    </div>
  );
}
