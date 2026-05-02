"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

type Theme = "auto" | "light" | "dark";
type EffectiveTheme = "light" | "dark";

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

function resolveInitialTheme(): Theme {
  if (typeof window === "undefined") return "auto";
  const saved = window.localStorage.getItem("remarka-theme") || window.localStorage.getItem("theme");
  if (saved === "auto" || saved === "light" || saved === "dark") return saved;
  return "auto";
}

function resolveEffectiveTheme(theme: Theme): EffectiveTheme {
  if (theme === "light" || theme === "dark") return theme;
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>("auto");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setTheme(resolveInitialTheme());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return undefined;

    const applyTheme = () => {
      const effectiveTheme = resolveEffectiveTheme(theme);
      const root = document.documentElement;
      root.setAttribute("data-theme", effectiveTheme);
      root.setAttribute("data-theme-mode", theme);
      if (effectiveTheme === "dark") {
        root.classList.add("dark");
      } else {
        root.classList.remove("dark");
      }
    };

    applyTheme();
    window.localStorage.setItem("remarka-theme", theme);

    if (theme !== "auto") return undefined;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [hydrated, theme]);

  const value = useMemo<ThemeContextType>(
    () => ({
      theme,
      setTheme,
      toggleTheme: () => {
        setTheme((prev) => (resolveEffectiveTheme(prev) === "light" ? "dark" : "light"));
      },
    }),
    [theme]
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
