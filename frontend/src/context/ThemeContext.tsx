import { createContext, useContext, useEffect, useState } from "react";

export type ThemePreference = "system" | "dark" | "light";

interface ThemeContextValue {
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
}

const STORAGE_KEY = "visiban-theme";

const ThemeContext = createContext<ThemeContextValue>({
  preference: "system",
  setPreference: () => {},
});

function applyTheme(preference: ThemePreference) {
  const root = document.documentElement;
  if (preference === "dark") {
    root.classList.add("dark");
  } else if (preference === "light") {
    root.classList.remove("dark");
  } else {
    // system
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.classList.toggle("dark", prefersDark);
  }
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

  useEffect(() => {
    applyTheme(preference);
  }, [preference]);

  // Keep system preference in sync with OS changes
  useEffect(() => {
    if (preference !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme("system");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [preference]);

  const setPreference = (p: ThemePreference) => {
    localStorage.setItem(STORAGE_KEY, p);
    setPreferenceState(p);
  };

  return (
    <ThemeContext.Provider value={{ preference, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
