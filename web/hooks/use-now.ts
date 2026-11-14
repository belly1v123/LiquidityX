"use client";
import { useEffect, useState } from "react";

/** Current unix time in seconds, ticking every `intervalMs`. 0 until mounted (avoids hydration mismatch). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
