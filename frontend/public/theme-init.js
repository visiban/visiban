// Theme initialization — runs before React mounts to prevent flash of
// incorrect theme. Reads the user's stored preference and applies the
// "dark" class + data-theme attribute to <html> immediately so the first
// paint matches the theme. Must stay in sync with ThemeContext.tsx.
(function () {
  var s = null;
  try {
    s = localStorage.getItem("user:prefs:theme");
  } catch (e) {}
  var prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  var isDark = s === "dark" || ((!s || s === "system") && prefersDark);
  var root = document.documentElement;
  if (isDark) {
    root.classList.add("dark");
  }
  root.setAttribute("data-theme", isDark ? "dark" : "light");
})();
