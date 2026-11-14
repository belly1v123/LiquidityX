import type { Metadata } from "next";
import { ActivityView } from "@/components/activity/activity-view";

export const metadata: Metadata = {
  title: "Activity",
  description: "Every LiquidityX transaction on Mezo testnet, each linked to the explorer.",
};

export default function ActivityPage() {
  return <ActivityView />;
}
