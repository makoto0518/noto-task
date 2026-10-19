/**
 * This classic (non-module) script runs in <head> before the first paint.
 * Setting data-theme early prevents a flash of light UI in dark mode.
 * Explicit choice wins over prefers-color-scheme and is stored per device.
 */
(() => {
  let saved;
  try { saved=localStorage.getItem('mizu_theme_v1'); } catch {}
  const dark=saved==='dark'||(saved!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme=dark?'dark':'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content',dark?'#111827':'#f5f8ff');
})();
