"use client";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type ThemeChoice } from "./theme";

const order: ThemeChoice[] = ["system", "light", "dark"];
const label: Record<ThemeChoice, string> = { system: "Theme: system", light: "Theme: light", dark: "Theme: dark" };

export function ThemeToggle() {
  const { choice, setChoice } = useTheme();
  const next = order[(order.indexOf(choice) + 1) % order.length];
  const Icon = choice === "dark" ? Moon : choice === "light" ? Sun : Monitor;
  return (
    <button
      type="button"
      onClick={() => setChoice(next)}
      aria-label={`${label[choice]}. Switch to ${next}.`}
      title={label[choice]}
      className="grid size-9 place-items-center rounded-md text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
    >
      <Icon className="size-4" strokeWidth={1.75} />
    </button>
  );
}
