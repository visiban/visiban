/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
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

        // Semantic — text/border/subtle-fill shades
        danger: "rgb(var(--danger) / <alpha-value>)",
        warning: "rgb(var(--warning) / <alpha-value>)",
        success: "rgb(var(--success) / <alpha-value>)",
        info: "rgb(var(--info) / <alpha-value>)",

        // Interactive — primary (Visiban brand blue)
        primary: "rgb(var(--primary) / <alpha-value>)",
        "primary-hover": "rgb(var(--primary-hover) / <alpha-value>)",
        "primary-emphasis": "rgb(var(--primary-emphasis) / <alpha-value>)",
        "primary-soft": "rgb(var(--primary-soft) / <alpha-value>)",

        // Interactive — destructive / warning / positive
        "danger-bg": "rgb(var(--danger-bg) / <alpha-value>)",
        "danger-bg-hover": "rgb(var(--danger-bg-hover) / <alpha-value>)",
        "danger-emphasis": "rgb(var(--danger-emphasis) / <alpha-value>)",
        "warning-bg": "rgb(var(--warning-bg) / <alpha-value>)",
        "warning-bg-hover": "rgb(var(--warning-bg-hover) / <alpha-value>)",
        "warning-emphasis": "rgb(var(--warning-emphasis) / <alpha-value>)",
        "success-bg": "rgb(var(--success-bg) / <alpha-value>)",
        "success-emphasis": "rgb(var(--success-emphasis) / <alpha-value>)",

        // On-color — text that sits on top of solid *-bg fills
        "on-primary": "rgb(var(--on-primary) / <alpha-value>)",
        "on-danger": "rgb(var(--on-danger) / <alpha-value>)",
        "on-warning": "rgb(var(--on-warning) / <alpha-value>)",

        // Accent — violet for non-standard semantic markers (reactivated events)
        "accent-violet": "rgb(var(--accent-violet) / <alpha-value>)",

        // Identity palette — mid-tone brand colors used for user avatar chips,
        // activity-type timeline dots, and role badges. These read identically
        // on both light and dark surfaces when paired with white/on-primary text.
        // Same value in both themes by design — they mark identity, not state.
        "palette-teal": "rgb(13 148 136 / <alpha-value>)",
        "palette-violet": "rgb(124 58 237 / <alpha-value>)",
        "palette-rose": "rgb(225 29 72 / <alpha-value>)",
        "palette-emerald": "rgb(5 150 105 / <alpha-value>)",
        "palette-cyan": "rgb(8 145 178 / <alpha-value>)",
        "palette-purple": "rgb(147 51 234 / <alpha-value>)",
        "palette-purple-deep": "rgb(88 28 135 / <alpha-value>)",     /* purple-900 — site admin badge bg */
        "palette-purple-soft": "rgb(216 180 254 / <alpha-value>)",   /* purple-300 — site admin badge text */
        "palette-purple-pale": "rgb(243 232 255 / <alpha-value>)",   /* purple-100 — role badge text */
        "palette-teal-pale": "rgb(204 251 241 / <alpha-value>)",     /* teal-100 — role badge text */

        // Activity timeline dots — event-type markers
        "activity-date": "rgb(56 189 248 / <alpha-value>)",     /* sky-400 */
        "activity-assign": "rgb(20 184 166 / <alpha-value>)",   /* teal-500 */
        "activity-reactivated": "rgb(139 92 246 / <alpha-value>)",  /* violet-500 */

        // Modal backdrop / scrim
        backdrop: "rgb(var(--backdrop) / <alpha-value>)",
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
