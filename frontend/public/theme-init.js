// Theme initialization — runs before React mounts to prevent flash of
// incorrect theme. Reads the user's stored preference and applies the
// "dark" class to <html> immediately so the first paint matches the theme.
(function () {
  var s = localStorage.getItem("visiban-theme");
  var prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  if (s === "dark" || (!s || s === "system") && prefersDark) {
    document.documentElement.classList.add("dark");
  }
})();
