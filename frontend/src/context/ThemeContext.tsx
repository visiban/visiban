import { createContext, useContext, useEffect, useState } from "react";

export type ThemePreference = "system" | "dark" | "light";

interface ThemeContextValue {
  preference: ThemePreference;
  /** Active rendered theme — "dark" or "light". Resolves "system" via matchMedia. */
  resolved: "dark" | "light";
  setPreference: (p: ThemePreference) => void;
}

export const STORAGE_KEY = "visiban-theme";

const ThemeContext = createContext<ThemeContextValue>({
  preference: "system",
  resolved: "dark",
  setPreference: () => {},
});

function resolve(preference: ThemePreference): "dark" | "light" {
  if (preference === "dark") return "dark";
  if (preference === "light") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(preference: ThemePreference): "dark" | "light" {
  const mode = resolve(preference);
  const root = document.documentElement;
  // The `.dark` class remains for any Tailwind `dark:` utility consumer.
  // `data-theme` is the canonical selector used by the CSS token layer
  // (index.css) and must match the resolved mode, not the raw preference.
  root.classList.toggle("dark", mode === "dark");
  root.setAttribute("data-theme", mode);
  return mode;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as ThemePreference | null;
    if (!stored) {
      localStorage.setItem(STORAGE_KEY, "system");
      return "system";
    }
    return stored;
  });
  const [resolved, setResolved] = useState<"dark" | "light">(() => resolve(preference));

  useEffect(() => {
    setResolved(applyTheme(preference));
  }, [preference]);

  // Keep system preference in sync with OS changes
  useEffect(() => {
    if (preference !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => setResolved(applyTheme("system"));
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [preference]);

  // Cross-tab sync — listen for the theme value changing in another tab.
  // The `storage` event fires in every tab EXCEPT the one that made the write,
  // which is exactly what we want. Guard on the key to avoid reacting to
  // unrelated localStorage writes (view prefs, saved filters, etc.).
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || !e.newValue) return;
      const next = e.newValue as ThemePreference;
      if (next === "system" || next === "dark" || next === "light") {
        setPreferenceState(next);
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const setPreference = (p: ThemePreference) => {
    localStorage.setItem(STORAGE_KEY, p);
    setPreferenceState(p);
  };

  return (
    <ThemeContext.Provider value={{ preference, resolved, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- intentional hook export alongside provider component
export function useTheme() {
  return useContext(ThemeContext);
}
