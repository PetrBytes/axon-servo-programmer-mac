/* Runs before first paint so the window never flashes the wrong (white) theme. */
(function () {
  var s = (window.native && window.native.initial) || {};
  if (!s.theme) { try { s = JSON.parse(localStorage.getItem('settings') || '{}'); } catch (e) { s = {}; } }
  var t = s.theme || 'system';
  var sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  var dark = t === 'dark' || t === 'midnight' || t === 'aurora' || t === 'sunset' || ((t === 'system' || t === 'glass') && sysDark);
  var r = document.documentElement;
  r.setAttribute('data-theme', dark ? 'dark' : 'light');
  r.style.colorScheme = dark ? 'dark' : 'light';
  if (t === 'midnight' || t === 'aurora' || t === 'sunset' || t === 'glass') r.setAttribute('data-skin', t);
  r.style.setProperty('--glass', String((s.glass == null ? 60 : s.glass) / 100));
})();
