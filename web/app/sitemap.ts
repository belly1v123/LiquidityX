import type { MetadataRoute } from "next";
import { siteUrl } from "@/components/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["", "/marketplace", "/lend", "/borrow", "/activity"].map((p) => ({
    url: `${siteUrl}${p}`,
    changeFrequency: p === "" ? "weekly" : "daily",
    priority: p === "" ? 1 : 0.7,
  }));
}
