/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        primary: "#5B5FC7",
        accent: "#2DD4BF",

        // Semantic design tokens (#183). The RGB-channel `<alpha-value>` pattern
        // is required so `/50`, `/10`, `/20` opacity modifiers keep working.
        // Dark values are set in index.css on :root AND [data-theme="dark"];
        // light values under [data-theme="light"].

        // Surfaces
        canvas: "rgb(var(--canvas) / <alpha-value>)",
        surface: "rgb(var(--surface) / <alpha-value>)",
        raised: "rgb(var(--surface-raised) / <alpha-value>)",
        sunken: "rgb(var(--surface-sunken) / <alpha-value>)",
        "surface-hover": "rgb(var(--surface-hover) / <alpha-value>)",
        "surface-active": "rgb(var(--surface-active) / <alpha-value>)",

        // Borders — `line-*` prefix avoids the `border-border-*` double prefix
        line: "rgb(var(--border-default) / <alpha-value>)",
        "line-subtle": "rgb(var(--border-subtle) / <alpha-value>)",
        "line-strong": "rgb(var(--border-strong) / <alpha-value>)",
        "line-emphasis": "rgb(var(--border-emphasis) / <alpha-value>)",

        // Foreground — `fg*` keys avoid the `text-text-*` double prefix
        fg: "rgb(var(--fg) / <alpha-value>)",
        "fg-secondary": "rgb(var(--fg-secondary) / <alpha-value>)",
        "fg-tertiary": "rgb(var(--fg-tertiary) / <alpha-value>)",
        "fg-muted": "rgb(var(--fg-muted) / <alpha-value>)",
        "fg-faint": "rgb(var(--fg-faint) / <alpha-value>)",

        // Semantic — text/border/subtle-fill usages switch shade across themes.
        // Button fills (bg-red-600, bg-green-600) stay hardcoded because a
        // danger button should read identically in both modes.
        danger: "rgb(var(--danger) / <alpha-value>)",
        warning: "rgb(var(--warning) / <alpha-value>)",
        success: "rgb(var(--success) / <alpha-value>)",
        info: "rgb(var(--info) / <alpha-value>)",
      },
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0", transform: "scale(0.97)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
      },
      animation: {
        "fade-in": "fade-in 120ms ease-out forwards",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
}
