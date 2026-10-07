// Applies the stored theme before the first paint (#73). index.html starts
// dark, and the app only applies a stored light theme once its bundle has
// run, so a light user saw a dark screen for a moment on every load. Loaded
// as a file, not inline, because the CSP allows only same-origin scripts.
// Resolves exactly as src/providers/theme-provider.tsx does: the person's
// choice, then the instance default it last saw, then dark; "system" follows
// the OS. A test runs this file against the provider's rules.
(() => {
  try {
    const mode = (value) =>
      value === 'light' || value === 'dark' || value === 'system' ? value : null;
    let theme =
      mode(localStorage.getItem('oci.theme')) ||
      mode(localStorage.getItem('oci.instanceTheme')) ||
      'dark';
    if (theme === 'system') {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.classList.toggle('light', theme === 'light');
    const color = localStorage.getItem('oci.colorTheme');
    root.dataset.colorTheme =
      color === 'blue' || color === 'violet' || color === 'emerald' ? color : 'neutral';
  } catch (_) {
    // Storage unavailable: keep the dark default; the app applies the theme.
  }
})();
