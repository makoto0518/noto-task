/**
 * 【初期テーマの設定】index.html の<head>で style.css より先に読み込む通常スクリプト。
 * 初回描画前に data-theme を指定し、ダークモードでも一瞬白く光る現象を防ぐ。
 * アプリ内で選んだテーマ（端末に保存）があれば、OSの自動設定より優先する。
 * app.js の切替ボタンとも連携するため、読込順や保存キーを変更するときは注意。
 */
(() => {
  let saved;
  try { saved=localStorage.getItem('mizu_theme_v1'); } catch {}
  const dark=saved==='dark'||(saved!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme=dark?'dark':'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content',dark?'#111827':'#f5f8ff');
})();
