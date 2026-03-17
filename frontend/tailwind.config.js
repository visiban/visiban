/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        primary: "#5B5FC7",
        accent: "#2DD4BF",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
}
