"use client";
import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";
type Resolved = "light" | "dark";

import { THEME_KEY as KEY } from "./theme-script";

const Ctx = createContext<{ choice: ThemeChoice; resolved: Resolved; setChoice: (c: ThemeChoice) => void }>({
  choice: "system",
  resolved: "light",
  setChoice: () => {},
});

function systemTheme(): Resolved {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>("system");
  const [resolved, setResolved] = useState<Resolved>("light");

  useEffect(() => {
    let stored: ThemeChoice = "system";
    try {
      const v = localStorage.getItem(KEY);
      if (v === "light" || v === "dark") stored = v;
    } catch {}
    // Reading localStorage must wait until after hydration, so this sync runs once in an effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setChoiceState(stored);
    setResolved(stored === "system" ? systemTheme() : stored);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  useEffect(() => {
    if (choice !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setResolved(mq.matches ? "dark" : "light");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [choice]);

  const setChoice = useCallback((c: ThemeChoice) => {
    setChoiceState(c);
    try {
      if (c === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, c);
    } catch {}
    setResolved(c === "system" ? systemTheme() : c);
  }, []);

  return <Ctx.Provider value={{ choice, resolved, setChoice }}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);
