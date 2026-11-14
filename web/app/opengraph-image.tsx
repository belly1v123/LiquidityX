import { ImageResponse } from "next/og";
import { OgCard } from "@/components/og";

export const alt = "LiquidityX: fixed-rate loans between people, backed by Bitcoin.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    <OgCard
      title="Fixed-rate loans between people, backed by Bitcoin."
      lines={["Lenders set the rate. Borrowers lock BTC."]}
      foot="Peer-to-peer stablecoin lending"
    />,
    size,
  );
}
