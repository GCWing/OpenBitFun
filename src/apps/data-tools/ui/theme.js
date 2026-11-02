// Select the public theme before first paint, then follow OS appearance changes.
(() => {
  const root = document.documentElement;
  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  const contrast = window.matchMedia('(prefers-contrast: more)');
  const applyTheme = () => {
    root.dataset.colorScheme = dark.matches ? 'dark' : 'light';
    root.dataset.contrast = contrast.matches ? 'high' : 'normal';
  };
  applyTheme();
  dark.addEventListener('change', applyTheme);
  contrast.addEventListener('change', applyTheme);
})();
